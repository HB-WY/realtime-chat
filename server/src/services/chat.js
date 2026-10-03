// src/services/chat.js
//
// 聊天业务的单一实现：消息 / 好友 / 群聊。
// Socket.IO handler 与 REST（API 密钥通道 /api/v1）都调用这里。
//
// 【本次改动】
//   · assertRoomAccess 修掉死代码（forSend 分支两边字面量相同）
//   · leaveGroup 群主解散时清掉该群全部消息与已读回执
//   · sendMessage 增加 stickerPackId 字段（校验存在性）
//
const { db } = require('../db');
const config = require('../config');
const { transaction } = require('../db/tx');
const helpers = require('../socket/helpers');
const registry = require('../socket/registry');
const prefs = require('./preferences');
const { sanitizeAvatar } = require('../utils/avatar');

const MSG_CFG = config.BUSINESS.message;
const U = config.BUSINESS.user;

function fail(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

function forbidden(msg) {
  const e = new Error(msg);
  e.status = 403;
  return e;
}

// ============================================================
// 权限
// ============================================================
function assertRoomAccess(userId, roomType, roomId, { forSend = false } = {}) {
  if (!['public', 'private', 'group'].includes(roomType) || !roomId) {
    throw fail('房间参数错误');
  }
  if (roomType === 'private') {
    const parts = String(roomId).replace(/^p_/, '').split('_').map(Number);
    if (!parts.includes(userId)) throw forbidden('无权访问该会话');
    return;
  }
  if (roomType === 'group') {
    const gid = Number(String(roomId).replace(/^g_/, ''));
    if (!helpers.isGroupMember(gid, userId)) {
      // [FIX] 原为 `forSend ? '不在群中' : '不在群中'`（两边字面量相同，死代码）
      throw forbidden(forSend ? '你不是该群成员，无法发言' : '你不是该群成员，无法查看消息');
    }
  }
}

// ============================================================
// 消息
// ============================================================

/**
 * [SEC] 文件名清洗：剥掉控制字符与 HTML 标签片段。
 *   消息正文由前端 React 转义渲染（全站无 innerHTML），但 file_name
 *   会出现在 tooltip / 下载卡片等多处属性位，服务端先做一道实体级清洗，
 *   避免「存储型 XSS 防线完全押在前端」。
 */
function sanitizeFileName(name) {
  return String(name)
    // 控制字符（含零宽）全部去掉
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    // < > 不允许出现在文件名里（避免任何下游把它拼进 HTML 属性）
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 200) || '未命名';
}

function loadHistory(userId, roomType, roomId, limit = MSG_CFG.history_limit) {
  assertRoomAccess(userId, roomType, roomId);
  const lim = Math.min(Math.max(Number(limit) || MSG_CFG.history_limit, 1), 500);
  return helpers.loadHistory(roomType, roomId, lim);
}

function sendMessage(user, data = {}) {
  const text = (data.text || '').toString().trim();
  const fileUrl = data.fileUrl ? String(data.fileUrl) : null;
  const fileName = data.fileName ? sanitizeFileName(data.fileName) : null;
  const fileType = data.fileType ? String(data.fileType).slice(0, 20) : null;
  const fileSize = Number.isFinite(Number(data.fileSize)) && data.fileSize !== null
    ? Number(data.fileSize) : null;
  const isSticker = !!data.isSticker;
  const stickerPackId = Number.isFinite(Number(data.stickerPackId))
    ? Number(data.stickerPackId) : null;
  const roomType = data.roomType;
  const roomId = data.roomId;

  if (!text && !fileUrl) throw fail('消息内容不能为空');
  if (text.length > MSG_CFG.text_max_len) throw fail('消息内容不合法');

  // [SEC] 附件地址只接受站内 /uploads/ 路径
  if (fileUrl !== null) {
    if (fileUrl.length > 500
        || fileUrl.includes('..')
        || !/^\/uploads\/[A-Za-z0-9_\-./]+$/.test(fileUrl)) {
      throw fail('附件地址不合法');
    }
  }

  if (isSticker) {
    if (!fileUrl || fileType !== 'image') {
      throw fail('表情消息必须携带图片');
    }
    // [NEW] stickerPackId 若提供必须真实存在（前端据此判断"右键显示购买"）
    if (stickerPackId) {
      const p = db.prepare(
        "SELECT id FROM sticker_packs WHERE id = ? AND status = 'active'"
      ).get(stickerPackId);
      if (!p) throw fail('表情所属的表情包不存在');
    }
  }

  assertRoomAccess(user.id, roomType, roomId, { forSend: true });

  // [FIX] senderAvatar 必须 fallback 到 user.avatar：
  //   registry 里的在线表**只在 socket 连接时**由 addSocket 登记，
  //   REST 通道（/api/v1/messages、API 密钥）的用户不在里面 ——
  //   `me` 会是 undefined，导致每一条通过 REST 发出的消息头像变空串，
  //   前端渲染时退化成首字母方块。
  //   user 由 authMiddleware 每次请求 loadUser 得到，字段与 registry 一致，
  //   并且是最新值（改完昵称/头像后立刻生效）。
  const me = registry.getOnlineUsers().get(user.id);
  const senderName = me?.nickname || user.nickname;
  const senderAvatar = me?.avatar || user.avatar || '';

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = Date.now();

  let replyToId = null, replyToName = null, replyToText = null;
  if (data.replyToId) {
    const orig = db.prepare('SELECT * FROM messages WHERE id = ?').get(data.replyToId);
    if (orig && orig.room_type === roomType && orig.room_id === roomId) {
      replyToId = orig.id;
      replyToName = orig.sender_name;
      replyToText = orig.text ? orig.text.slice(0, 100) : '[附件]';
    }
  }

  db.prepare(
    `INSERT INTO messages
      (id, room_type, room_id, sender_id, sender_name, sender_avatar, text,
       reply_to_id, reply_to_name, reply_to_text,
       file_url, file_name, file_type, file_size, is_sticker, sticker_pack_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, roomType, roomId, user.id, senderName, senderAvatar, text,
    replyToId, replyToName, replyToText,
    fileUrl, fileName, fileType, fileSize, isSticker ? 1 : 0, stickerPackId,
    createdAt
  );

  const msg = {
    id, roomType, roomId,
    senderId: user.id, senderName, senderAvatar,
    text,
    replyTo: replyToId ? { id: replyToId, name: replyToName, text: replyToText } : null,
    fileUrl, fileName, fileType, fileSize,
    isSticker,
    stickerPackId,
    readBy: [],
    createdAt
  };

  registry.emitToRoom(roomType, roomId, 'message:new', msg);
  return msg;
}

function recallMessage(user, messageId) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.sender_id !== user.id) throw forbidden('无权撤回');
  if (Date.now() - msg.created_at > MSG_CFG.recall_window_ms) throw fail('超过时限，无法撤回');

  // 撤回 = 直接删除（[FIX] 两条 DELETE 包进事务，中途崩溃不再留下孤儿回执）
  transaction(() => {
    db.prepare('DELETE FROM message_reads WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  })();

  registry.emitToRoom(msg.room_type, msg.room_id, 'message:recalled', {
    messageId, roomType: msg.room_type, roomId: msg.room_id
  });
  return { ok: true };
}

function markRead(user, messageId) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.sender_id === user.id) return { ok: false };
  if (msg.room_type !== 'private') return { ok: false };

  // [SEC] 只有这条私聊的两个参与者能标记已读
  const parts = String(msg.room_id).replace(/^p_/, '').split('_').map(Number);
  if (!parts.includes(user.id)) return { ok: false };

  const exists = db.prepare('SELECT 1 FROM message_reads WHERE message_id = ? AND user_id = ?')
    .get(messageId, user.id);
  if (exists) return { ok: true, already: true };

  db.prepare('INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)')
    .run(messageId, user.id, Date.now());
  registry.emitToRoom(msg.room_type, msg.room_id, 'message:read', {
    messageId, userId: user.id
  });
  return { ok: true };
}

// ============================================================
// 好友
// ============================================================
function listFriends(user) {
  return helpers.getFriends(user.id);
}

function listFriendRequests(user) {
  const received = db.prepare(
    `SELECT fr.id, fr.from_id AS fromId, fr.created_at AS createdAt,
            u.username, u.nickname, u.avatar
     FROM friend_requests fr JOIN users u ON u.id = fr.from_id
     WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
  ).all(user.id);

  const sent = db.prepare(
    `SELECT fr.id, fr.to_id AS toId, fr.created_at AS createdAt,
            u.username, u.nickname, u.avatar
     FROM friend_requests fr JOIN users u ON u.id = fr.to_id
     WHERE fr.from_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
  ).all(user.id);

  return { received, sent };
}

function requestFriend(user, username) {
  const target = db.prepare('SELECT id, username, nickname, avatar FROM users WHERE username = ?')
    .get((username || '').toString().trim());
  if (!target) throw notFound('用户不存在');
  if (target.id === user.id) throw fail('不能加自己为好友');
  if (helpers.isFriend(user.id, target.id)) throw fail('已经是好友了');

  const exists = db.prepare(
    `SELECT id FROM friend_requests
     WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status = 'pending'`
  ).get(user.id, target.id, target.id, user.id);
  if (exists) throw fail('已经发送过申请');

  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO friend_requests (from_id, to_id, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(user.id, target.id, 'pending', now);

  const reqObj = {
    id: Number(info.lastInsertRowid),
    fromId: user.id, toId: target.id,
    username: user.username, nickname: user.nickname, avatar: user.avatar,
    createdAt: now
  };
  registry.sendTo(target.id, 'friend:req:new', reqObj);
  return reqObj;
}

function acceptFriendRequest(user, requestId) {
  const req = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(Number(requestId));
  if (!req || req.to_id !== user.id || req.status !== 'pending') throw fail('申请不存在或已处理');

  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', req.id);
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)')
    .run(req.from_id, req.to_id, now);
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)')
    .run(req.to_id, req.from_id, now);

  for (const uid of [req.from_id, req.to_id]) {
    registry.sendTo(uid, 'friend:list', helpers.getFriends(uid));
  }
  registry.sendTo(req.from_id, 'friend:req:accepted', { byId: user.id, byName: user.nickname });
  return { ok: true, friendId: req.from_id };
}

function rejectFriendRequest(user, requestId) {
  const req = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(Number(requestId));
  if (!req || req.to_id !== user.id || req.status !== 'pending') throw fail('申请不存在或已处理');
  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('rejected', req.id);
  registry.sendTo(req.from_id, 'friend:req:rejected', { byId: user.id });
  return { ok: true };
}

function removeFriend(user, friendId) {
  const fid = Number(friendId);
  if (!fid || fid === user.id) throw fail('好友参数错误');
  db.prepare('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?').run(user.id, fid);
  db.prepare('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?').run(fid, user.id);
  registry.sendTo(user.id, 'friend:list', helpers.getFriends(user.id));
  registry.sendTo(fid, 'friend:list', helpers.getFriends(fid));
  return { ok: true };
}

function searchUsers(user, keyword) {
  const q = (keyword || '').toString().trim();
  if (!q) return [];
  return db.prepare(
    `SELECT id, username, nickname, avatar FROM users
     WHERE (instr(username, ?) > 0 OR instr(nickname, ?) > 0) AND id != ?
     LIMIT 20`
  ).all(q, q, user.id);
}

// ============================================================
// 群聊
// ============================================================
function listGroups(user) {
  return helpers.getGroups(user.id);
}

function createGroup(user, name, memberIds) {
  const n = (name || '').toString().trim();
  if (!n || n.length > U.group_name.max_len) {
    throw fail(`群名需为 1-${U.group_name.max_len} 字符`);
  }

  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO groups (name, avatar, owner_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(n, '', user.id, now);
  const gid = Number(info.lastInsertRowid);

  db.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(gid, user.id, 'owner', now);

  if (Array.isArray(memberIds)) {
    for (const uid of memberIds.map(Number)) {
      if (uid === user.id) continue;
      if (!helpers.isFriend(user.id, uid)) continue;
      db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(gid, uid, 'member', now);
    }
  }

  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
  for (const m of members) registry.sendTo(m.user_id, 'group:list', helpers.getGroups(m.user_id));

  return { groupId: gid, name: n };
}

function getGroupInfo(user, groupId) {
  const gid = Number(groupId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');
  const myRole = helpers.getGroupMemberRole(gid, user?.id);

  const isOwner = grp.owner_id === user?.id;
  if (!myRole && !isOwner) throw forbidden('不在群中，无权查看群成员');

  return {
    id: grp.id,
    name: grp.name,
    avatar: grp.avatar || '',
    ownerId: grp.owner_id,
    myRole: myRole || (isOwner ? 'owner' : ''),
    canEditIcon: helpers.canManageGroupIcon(gid, user?.id, grp.owner_id),
    members: helpers.getGroupMembers(gid)
  };
}

function updateGroup(user, groupId, body = {}) {
  const gid = Number(groupId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');

  const myRole = helpers.getGroupMemberRole(gid, user.id);
  const isOwner = grp.owner_id === user.id || myRole === 'owner';
  const canEditIcon = helpers.canManageGroupIcon(gid, user.id, grp.owner_id);

  const sets = [];
  const args = [];
  if (body.name !== undefined) {
    if (!isOwner) throw forbidden('只有群主可以修改群名');
    const n = (body.name || '').toString().trim();
    if (!n || n.length > U.group_name.max_len) {
      throw fail(`群名需为 1-${U.group_name.max_len} 字符`);
    }
    sets.push('name = ?'); args.push(n);
  }
  if (body.avatar !== undefined) {
    if (!canEditIcon) throw forbidden('只有群主或群管理员可以修改群图标');
    const a = sanitizeAvatar((body.avatar ?? '').toString());
    sets.push('avatar = ?'); args.push(a);
  }
  if (sets.length === 0) throw fail('没有需要更新的内容');

  args.push(gid);
  db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  broadcastGroupUpdated(gid);
  return getGroupInfo(user, gid);
}

function broadcastGroupUpdated(gid) {
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
  for (const m of members) {
    registry.sendTo(m.user_id, 'group:updated', { groupId: gid });
    registry.sendTo(m.user_id, 'group:list', helpers.getGroups(m.user_id));
  }
}

function setGroupMemberRole(user, groupId, targetId, role) {
  const gid = Number(groupId);
  const tid = Number(targetId);
  if (!['admin', 'member'].includes(role)) throw fail('角色只能是 admin 或 member');

  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');
  if (grp.owner_id !== user.id) throw forbidden('只有群主可以任免群管理员');
  if (tid === grp.owner_id || tid === user.id) throw fail('不能修改群主的身份');

  const current = helpers.getGroupMemberRole(gid, tid);
  if (!current) throw fail('对方不在群中');
  if (current === 'owner') throw fail('不能修改群主的身份');
  if (current === role) return { ok: true, unchanged: true };

  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?')
    .run(role, gid, tid);

  registry.sendTo(tid, 'group:list', helpers.getGroups(tid));
  broadcastGroupUpdated(gid);

  return { ok: true, group: getGroupInfo(user, gid) };
}

function requestJoinGroup(user, groupId) {
  const gid = Number(groupId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');
  if (helpers.isGroupMember(gid, user.id)) throw fail('已在群中');

  const exists = db.prepare(
    'SELECT id FROM group_requests WHERE group_id = ? AND user_id = ? AND status = ?'
  ).get(gid, user.id, 'pending');
  if (exists) throw fail('申请已提交');

  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO group_requests (group_id, user_id, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(gid, user.id, 'pending', now);

  registry.sendTo(grp.owner_id, 'group:req:new', {
    id: Number(info.lastInsertRowid),
    groupId: gid, groupName: grp.name,
    userId: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar,
    createdAt: now
  });
  return { ok: true };
}

function listGroupRequests(user) {
  const mine = db.prepare(
    `SELECT gr.id, gr.group_id AS groupId, gr.created_at AS createdAt, g.name AS groupName
     FROM group_requests gr JOIN groups g ON g.id = gr.group_id
     WHERE gr.user_id = ? AND gr.status = 'pending' ORDER BY gr.created_at DESC`
  ).all(user.id);

  const pending = db.prepare(
    `SELECT gr.id, gr.group_id AS groupId, gr.user_id AS userId, gr.created_at AS createdAt,
            g.name AS groupName, u.username, u.nickname, u.avatar
     FROM group_requests gr
     JOIN groups g ON g.id = gr.group_id
     JOIN users u ON u.id = gr.user_id
     WHERE g.owner_id = ? AND gr.status = 'pending'
     ORDER BY gr.created_at DESC`
  ).all(user.id);

  return { mine, pending };
}

function approveGroupRequest(user, requestId) {
  const req = db.prepare('SELECT * FROM group_requests WHERE id = ?').get(Number(requestId));
  if (!req || req.status !== 'pending') throw fail('申请不存在或已处理');
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.group_id);
  if (!grp || grp.owner_id !== user.id) throw forbidden('只有群主可以审批');

  db.prepare('UPDATE group_requests SET status = ? WHERE id = ?').run('approved', req.id);
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(req.group_id, req.user_id, 'member', Date.now());

  registry.sendTo(req.user_id, 'group:list', helpers.getGroups(req.user_id));
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(req.group_id);
  for (const m of members) registry.sendTo(m.user_id, 'group:updated', { groupId: req.group_id });

  return { ok: true };
}

function rejectGroupRequest(user, requestId) {
  const req = db.prepare('SELECT * FROM group_requests WHERE id = ?').get(Number(requestId));
  if (!req || req.status !== 'pending') throw fail('申请不存在或已处理');
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.group_id);
  if (!grp || grp.owner_id !== user.id) throw forbidden('只有群主可以审批');

  db.prepare('UPDATE group_requests SET status = ? WHERE id = ?').run('rejected', req.id);
  registry.sendTo(req.user_id, 'group:req:rejected', { groupId: req.group_id });
  return { ok: true };
}

function inviteToGroup(user, groupId, targetId) {
  const gid = Number(groupId);
  const tid = Number(targetId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');
  if (!helpers.isGroupMember(gid, user.id)) throw forbidden('你不在群中');
  if (!helpers.isFriend(user.id, tid)) throw fail('只能邀请好友');
  if (helpers.isGroupMember(gid, tid)) throw fail('对方已在群中');

  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(gid, tid, 'member', Date.now());

  registry.sendTo(tid, 'group:list', helpers.getGroups(tid));
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
  for (const m of members) registry.sendTo(m.user_id, 'group:updated', { groupId: gid });

  return { ok: true };
}

function leaveGroup(user, groupId) {
  const gid = Number(groupId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp) throw notFound('群不存在');

  if (grp.owner_id === user.id) {
    const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
    // [FIX] 群主解散时清掉该群全部消息与已读回执
    //   （原先只删 groups/members/requests，消息变孤儿，库只涨不减）
    db.prepare(
      'DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE room_type = ? AND room_id = ?)'
    ).run('group', `g_${gid}`);
    db.prepare('DELETE FROM messages WHERE room_type = ? AND room_id = ?').run('group', `g_${gid}`);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(gid);
    db.prepare('DELETE FROM group_requests WHERE group_id = ?').run(gid);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    prefs.purgeRoomPreferences(`g_${gid}`);
    for (const m of members) registry.sendTo(m.user_id, 'group:removed', { groupId: gid });
    return { ok: true, dissolved: true };
  }

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, user.id);
  prefs.purgeRoomPreference(user.id, `g_${gid}`);
  registry.sendTo(user.id, 'group:list', helpers.getGroups(user.id));
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
  for (const m of members) registry.sendTo(m.user_id, 'group:updated', { groupId: gid });

  return { ok: true, dissolved: false };
}

function kickFromGroup(user, groupId, targetId) {
  const gid = Number(groupId);
  const tid = Number(targetId);
  const grp = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!grp || grp.owner_id !== user.id) throw forbidden('只有群主可以移除成员');
  if (tid === user.id) throw fail('不能移除自己');

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, tid);
  prefs.purgeRoomPreference(tid, `g_${gid}`);
  registry.sendTo(tid, 'group:removed', { groupId: gid });
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
  for (const m of members) registry.sendTo(m.user_id, 'group:updated', { groupId: gid });

  return { ok: true };
}

function searchGroups(user, keyword) {
  const q = (keyword || '').toString().trim();
  if (!q) return [];
  return db.prepare(
    `SELECT g.id, g.name, g.avatar, g.owner_id AS ownerId,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
     FROM groups g
     WHERE instr(g.name, ?) > 0 AND g.id NOT IN (
       SELECT group_id FROM group_members WHERE user_id = ?
     )
     LIMIT 20`
  ).all(q, user.id);
}

module.exports = {
  assertRoomAccess,
  loadHistory, sendMessage, recallMessage, markRead,
  listFriends, listFriendRequests, requestFriend,
  acceptFriendRequest, rejectFriendRequest, removeFriend, searchUsers,
  listGroups, createGroup, getGroupInfo, updateGroup, setGroupMemberRole,
  requestJoinGroup, listGroupRequests, approveGroupRequest, rejectGroupRequest,
  inviteToGroup, leaveGroup, kickFromGroup, searchGroups,
  listOnlineUsers: (user) => registry.onlineListFor(user?.id)
};