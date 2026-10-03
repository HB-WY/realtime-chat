// src/routes/v1.js
//
// REST 镜像层：把原本只在 Socket.IO 上暴露的操作（消息 / 好友 / 群聊 / 在线状态 /
// **转账 / 红包**）用 HTTP 暴露出来，配合 API 密钥通道，做到「凡前端能做的操作，
// 脚本携带密钥均可等价调用」——解决 curl 无法直接访问的问题。
//
// 与 socket handler 共用 services/chat.js / transfers.js / redpackets.js，
// 行为一致（含实时推送）。
//
const express = require('express');
const config = require('../config');
const { authMiddleware } = require('../auth');
const chat = require('../services/chat');
const transfers = require('../services/transfers');
const redpackets = require('../services/redpackets');
const { getBalance } = require('../services/points');

const router = express.Router();

// ============================================================
// REST 通道限流（按用户，进程内滑动窗口）
//
// 背景：以下端点此前**没有任何限流** ——
//   · POST /api/messages（发消息）：socket 侧有 rate_limits.socket.message
//     挡着，REST 侧没有；API 密钥通道只有全局 600/min，脚本可以无限刷
//   · GET /api/messages（拉历史）：走 messages 表 + message_reads JOIN，
//     limit 上限 500，反复拉会对库造成压力
//   · /api/users/search / /api/groups/search：services/chat.js 用 instr()
//     全表扫（SQLite 走不了索引），socket 侧有 presence 限流、REST 侧没有
//
// [CHANGED] 参数**不复用** socket 的 rate_limits.socket.* —— 两者的服务对象不同：
//   · socket 面向真人：5/s 是极限，是很紧的阈值
//   · REST + API 密钥面向脚本：批量调用是正常用法
//   如果复用 socket 参数，脚本密集调用（例如 smoke_test 的 5 条连续
//   POST /messages）会以 429 被挡下，误伤正常脚本。
//   独立参数见 config.yaml → rate_limits.rest.*，且已有的
//   rate_limits.apikey（600/min）依然是**总闸**兜底。
//
// 三个类别分开计数（不共用一个桶）：
//   message —— 发消息
//   search  —— 搜索 / 状态 / 在线列表
//   history —— 拉历史
// ============================================================
const REST_CFG = config.RATE_LIMITS.rest || {};
const MSG_RL    = REST_CFG.message || { per_second: 20, per_minute: 600 };
const SEARCH_RL = REST_CFG.search  || { per_second: 10, per_minute: 300 };
const HIST_RL   = REST_CFG.history || { per_second: 20, per_minute: 600 };

/** `${kind}:${userId}` -> { secStart, secCount, minStart, minCount } */
const rlBuckets = new Map();

function allowRate(kind, userId, cfg) {
  const now = Date.now();
  const key = `${kind}:${userId}`;
  let c = rlBuckets.get(key);
  if (!c) {
    // 简单的防膨胀：桶数超过 1 万直接清空（进程内限流，清空代价可接受）
    if (rlBuckets.size > 10000) rlBuckets.clear();
    c = { secStart: now, secCount: 0, minStart: now, minCount: 0 };
    rlBuckets.set(key, c);
  }
  if (now - c.secStart >= 1000)  { c.secStart = now; c.secCount = 0; }
  if (now - c.minStart >= 60000) { c.minStart = now; c.minCount = 0; }
  c.secCount++;
  c.minCount++;
  return c.secCount <= cfg.per_second && c.minCount <= cfg.per_minute;
}

const allowMessage = (userId) => allowRate('msg', userId, MSG_RL);
const allowSearch  = (userId) => allowRate('search', userId, SEARCH_RL);
const allowHistory = (userId) => allowRate('hist', userId, HIST_RL);

function tooMany(msg = '操作太频繁，请稍后再试') {
  const e = new Error(msg);
  e.status = 429;
  return e;
}

function wrap(handler) {
  return (req, res) => {
    try {
      const out = handler(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message || '操作失败' });
    }
  };
}

// ============================================================
// 会话快照 / 在线状态
// ============================================================
router.get('/state', authMiddleware, wrap((req) => {
  if (!allowSearch(req.user.id)) throw tooMany();
  return {
    user: req.user,
    authType: req.authType || 'jwt',
    friends: chat.listFriends(req.user),
    groups: chat.listGroups(req.user),
    friendRequests: chat.listFriendRequests(req.user),
    groupRequests: chat.listGroupRequests(req.user),
    // [SEC] 在线列表按调用者的关系范围收敛（原来是全站在线用户的
    //       id/username/nickname/avatar，等于一个现成的用户枚举通道）
    online: chat.listOnlineUsers(req.user),
    points: getBalance(req.user.id)
  };
}));

router.get('/presence/online', authMiddleware, wrap((req) => {
  if (!allowSearch(req.user.id)) throw tooMany();
  return { online: chat.listOnlineUsers(req.user) };
}));

// [SEC] searchUsers / searchGroups 内部走 instr() 全表扫（SQLite 走不了索引），
//   在 socket 侧受 rate_limits.socket.presence 限流、REST 侧之前完全没有 ——
//   这里补上，参数见文件顶部说明（独立于 socket）。
router.get('/users/search', authMiddleware, wrap((req) => {
  if (!allowSearch(req.user.id)) throw tooMany('搜索太频繁，请稍后再试');
  return { users: chat.searchUsers(req.user, req.query.keyword) };
}));

router.get('/groups/search', authMiddleware, wrap((req) => {
  if (!allowSearch(req.user.id)) throw tooMany('搜索太频繁，请稍后再试');
  return { groups: chat.searchGroups(req.user, req.query.keyword) };
}));

// ============================================================
// 消息
// ============================================================
router.get('/messages', authMiddleware, wrap((req) => {
  // [SEC] 拉历史走的是 messages 表 + message_reads JOIN，
  //   limit 上限 500，不加限流就是现成的 DoS 面。
  //   用**独立**的 history 桶：与发消息分开计数，
  //   脚本一次循环「读历史 → 处理 → 发回复」不会因为共用桶而互相挤占额度。
  if (!allowHistory(req.user.id)) throw tooMany('查询太频繁，请稍后再试');
  return {
    roomType: req.query.roomType || 'public',
    roomId: req.query.roomId || 'public',
    messages: chat.loadHistory(
      req.user.id,
      (req.query.roomType || 'public').toString(),
      (req.query.roomId || 'public').toString(),
      req.query.limit
    )
  };
}));

router.post('/messages', authMiddleware, wrap((req) => {
  if (!allowMessage(req.user.id)) throw tooMany('发送太频繁，请稍后再试');
  return {
    ok: true,
    message: chat.sendMessage(req.user, req.body || {})
  };
}));

router.post('/messages/:id/recall', authMiddleware, wrap((req) =>
  chat.recallMessage(req.user, req.params.id)
));

router.post('/messages/:id/read', authMiddleware, wrap((req) =>
  chat.markRead(req.user, req.params.id)
));

// ============================================================
// 好友
// ============================================================
router.get('/friends/requests', authMiddleware, wrap((req) =>
  chat.listFriendRequests(req.user)
));

router.post('/friends/requests', authMiddleware, wrap((req) =>
  chat.requestFriend(req.user, req.body?.username ?? req.body?.toUsername)
));

router.post('/friends/requests/:id/accept', authMiddleware, wrap((req) =>
  chat.acceptFriendRequest(req.user, req.params.id)
));

router.post('/friends/requests/:id/reject', authMiddleware, wrap((req) =>
  chat.rejectFriendRequest(req.user, req.params.id)
));

router.delete('/friends/:id', authMiddleware, wrap((req) =>
  chat.removeFriend(req.user, req.params.id)
));

// ============================================================
// 群聊
// ============================================================
router.post('/groups', authMiddleware, wrap((req) =>
  chat.createGroup(req.user, req.body?.name, req.body?.memberIds)
));

router.get('/groups/requests', authMiddleware, wrap((req) =>
  chat.listGroupRequests(req.user)
));

router.get('/groups/:id', authMiddleware, wrap((req) => ({
  group: chat.getGroupInfo(req.user, req.params.id)
})));

router.patch('/groups/:id', authMiddleware, wrap((req) => ({
  ok: true,
  group: chat.updateGroup(req.user, req.params.id, req.body || {})
})));

router.delete('/groups/:id/members/me', authMiddleware, wrap((req) =>
  chat.leaveGroup(req.user, req.params.id)
));

router.delete('/groups/:id/members/:userId', authMiddleware, wrap((req) =>
  chat.kickFromGroup(req.user, req.params.id, req.params.userId)
));

router.post('/groups/:id/members', authMiddleware, wrap((req) =>
  chat.inviteToGroup(req.user, req.params.id, req.body?.userId)
));

// 任免群管理员（仅群主）：{ role: 'admin' | 'member' }
router.post('/groups/:id/members/:userId/role', authMiddleware, wrap((req) =>
  chat.setGroupMemberRole(req.user, req.params.id, req.params.userId, req.body?.role)
));

router.post('/groups/:id/requests', authMiddleware, wrap((req) =>
  chat.requestJoinGroup(req.user, req.params.id)
));

router.post('/groups/requests/:id/approve', authMiddleware, wrap((req) =>
  chat.approveGroupRequest(req.user, req.params.id)
));

router.post('/groups/requests/:id/reject', authMiddleware, wrap((req) =>
  chat.rejectGroupRequest(req.user, req.params.id)
));

// ============================================================
// 支付系统（转账 / 红包）
//
// 说明：
//   · 与 /api/transfers / /api/redpackets 走同一套 services，
//     所以通过密钥通道调 /api/v1/transfers 也能转账、发红包。
//   · 幂等与限流在 services 内部（daily_limit + rate_limits.payments），
//     这条通道不比 socket 更宽松。
// ============================================================

// ----- 转账 -----
router.post('/transfers', authMiddleware, wrap((req) => {
  const { toUserId, amount, note } = req.body || {};
  return transfers.create(req.user, {
    toUserId: Number(toUserId),
    amount: Number(amount),
    note
  });
}));

router.post('/transfers/:id/accept', authMiddleware, wrap((req) =>
  transfers.accept(req.user.id, req.params.id)
));

router.post('/transfers/:id/reject', authMiddleware, wrap((req) =>
  transfers.reject(req.user.id, req.params.id)
));

router.get('/transfers/:id', authMiddleware, wrap((req) => {
  const t = transfers.getById(req.user.id, req.params.id);
  if (!t) {
    const e = new Error('转账不存在或无权查看');
    e.status = 404;
    throw e;
  }
  return { transfer: t };
}));

router.get('/transfers/mine', authMiddleware, wrap((req) => ({
  transfers: transfers.listMine(req.user.id, String(req.query.role || 'all'), req.query.limit)
})));

// ----- 红包 -----
router.post('/redpackets', authMiddleware, wrap((req) => {
  const { roomType, roomId, totalAmount, count, mode, note } = req.body || {};
  return redpackets.create(req.user, {
    roomType: String(roomType || ''),
    roomId: String(roomId || ''),
    totalAmount: Number(totalAmount),
    count: Number(count),
    mode: mode || 'lucky',
    note
  });
}));

router.post('/redpackets/:id/grab', authMiddleware, wrap((req) =>
  redpackets.grab(req.user.id, req.params.id)
));

router.get('/redpackets/:id', authMiddleware, wrap((req) => {
  const r = redpackets.getById(req.user.id, req.params.id);
  if (!r) {
    const e = new Error('红包不存在或无权查看');
    e.status = 404;
    throw e;
  }
  return { redPacket: r };
}));

router.get('/redpackets/mine', authMiddleware, wrap((req) => ({
  redPackets: redpackets.listMine(req.user.id, String(req.query.role || 'all'), req.query.limit)
})));

module.exports = router;