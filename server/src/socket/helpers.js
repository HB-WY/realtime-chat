// src/socket/helpers.js
//
// 【本次改动】
//   · loadHistory 返回 stickerPackId（上一轮）与 refType / refId（本轮）
//   · 让"红包 / 转账"这类通过 ref_type/ref_id 挂到消息上的条目，
//     在客户端渲染成专用卡片。
//
const { db } = require('../db');
const RL        = require('../config').RATE_LIMITS.socket;
const MSG_CFG   = require('../config').BUSINESS.message;

function privateRoomId(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `p_${x}_${y}`;
}

function getFriends(userId) {
  return db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.signature
     FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.nickname`
  ).all(userId);
}

function getGroups(userId) {
  return db.prepare(
    `SELECT g.id, g.name, g.avatar, g.owner_id,
       (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS member_count
     FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE m.user_id = ? ORDER BY g.name`
  ).all(userId);
}

function getGroupMembers(groupId) {
  // 群主 → 群管理员 → 普通成员
  return db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, m.role
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.nickname`
  ).all(groupId);
}

function isFriend(userId, targetId) {
  return !!db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(userId, targetId);
}

/**
 * 与 userId 存在「可交互关系」的用户 id 集合：自己 + 好友 + 同群成员。
 *
 * [SEC] 在线状态只在这个范围内可见。原来 /api/v1/state 与 socket 的
 *       `users:online` 广播都把**全站在线用户**的 id/username/nickname/avatar
 *       发给任何登录用户 / 任何有效密钥，是一个现成的用户枚举通道。
 *       群聊需要知道群成员在线与否，所以「同群」也算关系内。
 */
function relatedUserIds(userId) {
  const id = Number(userId);
  const ids = new Set([id]);
  const rows = db.prepare(
    `SELECT friend_id AS uid FROM friendships WHERE user_id = ?
     UNION
     SELECT user_id   AS uid FROM friendships WHERE friend_id = ?
     UNION
     SELECT m2.user_id AS uid
       FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id
      WHERE m1.user_id = ?`
  ).all(id, id, id);
  for (const r of rows) ids.add(Number(r.uid));
  return ids;
}

function isGroupMember(groupId, userId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

/** 群成员身份：'owner' | 'admin' | 'member'，不在群中返回 null */
function getGroupMemberRole(groupId, userId) {
  const row = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(Number(groupId), Number(userId));
  return row?.role || null;
}

/** 群主或群管理员可以维护群资料里的图标 */
function canManageGroupIcon(groupId, userId, ownerId) {
  const role = getGroupMemberRole(groupId, userId);
  return role === 'owner' || role === 'admin' || Number(ownerId) === Number(userId);
}

// ============================================================
// 房间设置（公共聊天图标，存在 room_settings）
// ============================================================
const PUBLIC_ROOM_KEY = 'public';
const PUBLIC_ROOM_NAME = '公共聊天';

function getPublicRoom() {
  const row = db.prepare('SELECT * FROM room_settings WHERE room_key = ?').get(PUBLIC_ROOM_KEY);
  return {
    roomKey: PUBLIC_ROOM_KEY,
    type: 'public',
    name: PUBLIC_ROOM_NAME,
    icon: row?.icon || '',
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at || null
  };
}

function getRoomMemberIds(roomType, roomId) {
  if (roomType === 'public') return null;
  if (roomType === 'private') {
    return roomId.replace(/^p_/, '').split('_').map(Number);
  }
  if (roomType === 'group') {
    const gid = Number(roomId.replace(/^g_/, ''));
    return db.prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(gid).map((m) => m.user_id);
  }
  return [];
}

function loadHistory(roomType, roomId, limit = MSG_CFG.history_limit) {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE room_type = ? AND room_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(roomType, roomId, limit);

  if (rows.length === 0) return [];

  const readsByMsg = new Map();
  if (roomType === 'private') {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const readRows = db.prepare(
      `SELECT message_id, user_id FROM message_reads WHERE message_id IN (${placeholders})`
    ).all(...ids);
    for (const rr of readRows) {
      if (!readsByMsg.has(rr.message_id)) readsByMsg.set(rr.message_id, []);
      readsByMsg.get(rr.message_id).push(rr.user_id);
    }
  }

  return rows.reverse().map((r) => ({
    id: r.id,
    roomType: r.room_type,
    roomId: r.room_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    senderAvatar: r.sender_avatar || '',
    text: r.text || '',
    replyTo: r.reply_to_id
      ? { id: r.reply_to_id, name: r.reply_to_name, text: r.reply_to_text }
      : null,
    fileUrl: r.file_url || null,
    fileName: r.file_name || null,
    fileType: r.file_type || null,
    fileSize: typeof r.file_size === 'number' ? r.file_size : null,
    isSticker: !!r.is_sticker,
    // 上一轮：表情消息带上所属表情包 id
    stickerPackId: r.sticker_pack_id || null,
    // 【本次新增】红包 / 转账：通过 ref_type / ref_id 让前端渲染专用卡片
    refType: r.ref_type || null,
    refId: typeof r.ref_id === 'number' ? r.ref_id : null,
    readBy: readsByMsg.get(r.id) || [],
    createdAt: r.created_at
  }));
}

function buildInitState(user) {
  return {
    user: {
      id: user.id, username: user.username, nickname: user.nickname,
      avatar: user.avatar || '', signature: user.signature || '', role: user.role || 'user'
    },
    // 公共聊天房（图标由开发者在 room_settings 里维护）
    publicRoom: getPublicRoom(),
    friends: getFriends(user.id),
    groups: getGroups(user.id),
    receivedFriendRequests: db.prepare(
      `SELECT fr.id, fr.from_id AS fromId, fr.created_at AS createdAt,
              u.username, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON u.id = fr.from_id
       WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
    ).all(user.id),
    sentFriendRequests: db.prepare(
      `SELECT fr.id, fr.to_id AS toId, fr.created_at AS createdAt,
              u.username, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON u.id = fr.to_id
       WHERE fr.from_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
    ).all(user.id),
    myGroupRequests: db.prepare(
      `SELECT gr.id, gr.group_id AS groupId, gr.created_at AS createdAt, g.name AS groupName
       FROM group_requests gr JOIN groups g ON g.id = gr.group_id
       WHERE gr.user_id = ? AND gr.status = 'pending' ORDER BY gr.created_at DESC`
    ).all(user.id),
    pendingGroupRequests: db.prepare(
      `SELECT gr.id, gr.group_id AS groupId, gr.user_id AS userId, gr.created_at AS createdAt,
              g.name AS groupName, u.username, u.nickname, u.avatar
       FROM group_requests gr
       JOIN groups g ON g.id = gr.group_id
       JOIN users u ON u.id = gr.user_id
       WHERE g.owner_id = ? AND gr.status = 'pending'
       ORDER BY gr.created_at DESC`
    ).all(user.id)
  };
}

/**
 * 限流器工厂。
 * @param {string} kind  在 config.yaml → rate_limits.socket 下的键名
 *                       例：'message' | 'write'
 *
 * [FIX] 计数改为**按用户**（进程级 Map），不再按连接：
 *       原实现每个 socket 一份计数器，同一用户多开连接就能线性放大额度
 *       （100 个连接 = 100 倍限流上限）。key 缺省时退化为按连接（兼容旧调用）。
 */
const limiterBuckets = new Map(); // `${kind}:${key}` -> counters
let limiterOps = 0;

function pruneLimiterBuckets() {
  // 简单防膨胀：定期清掉整个桶（计数窗口最多 60s，清空的代价可忽略）
  if (limiterBuckets.size > 10000) limiterBuckets.clear();
}

function makeRateLimiter(kind) {
  const cfg = RL[kind];
  if (!cfg) throw new Error(`[socket] 未知限流类型: ${kind}`);
  const { per_second, per_minute } = cfg;

  return function allow(key = '_') {
    const bucketKey = `${kind}:${key}`;
    let c = limiterBuckets.get(bucketKey);
    const now = Date.now();
    if (!c) {
      c = { secStart: now, secCount: 0, minStart: now, minCount: 0 };
      limiterBuckets.set(bucketKey, c);
      if (++limiterOps >= 1000) { limiterOps = 0; pruneLimiterBuckets(); }
    }
    if (now - c.secStart >= 1000)  { c.secStart = now; c.secCount = 0; }
    if (now - c.minStart >= 60000) { c.minStart = now; c.minCount = 0; }
    c.secCount++;
    c.minCount++;
    return c.secCount <= per_second && c.minCount <= per_minute;
  };
}

module.exports = {
  privateRoomId,
  getFriends, getGroups, getGroupMembers,
  isFriend, isGroupMember, getRoomMemberIds,
  relatedUserIds,
  getGroupMemberRole, canManageGroupIcon,
  getPublicRoom, PUBLIC_ROOM_KEY,
  loadHistory, buildInitState, makeRateLimiter
};
