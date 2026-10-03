// src/socket/registry.js
//
// Socket.IO 实例注册表。
//
// 【本次改动】broadcastOnline 把 relatedUserIds 的 N×3 次 SQL 收敛成 3 次：
//   原实现对每个在线用户调一次 helpers.relatedUserIds()（friendships UNION 两次 +
//   group_members 自连接）。100 个在线用户 = 300 次 SQL / 每次上下线都跑一遍。
//   现在一次性把「所有在线用户」的好友 / 同群关系批量取出来，内存里分派。
//
const helpers = require('./helpers');
const { db } = require('../db');
const PRESENCE_ALL = require('../config').PRESENCE_SCOPE === 'all';

let io = null;
const onlineUsers = new Map();

function init(ioInstance) {
  io = ioInstance;
}

function getIo() {
  return io;
}

function getOnlineCount() {
  return onlineUsers.size;
}

function getOnlineUsers() {
  return onlineUsers;
}

function addSocket(user, socketId) {
  if (!onlineUsers.has(user.id)) {
    onlineUsers.set(user.id, { ...user, sockets: new Set() });
  }
  onlineUsers.get(user.id).sockets.add(socketId);
  return onlineUsers.get(user.id);
}

function removeSocket(userId, socketId) {
  const u = onlineUsers.get(userId);
  if (!u) return false;
  u.sockets.delete(socketId);
  if (u.sockets.size === 0) {
    onlineUsers.delete(userId);
    return true;
  }
  return false;
}

/**
 * 在线用户的最小字段集。
 *
 * [SEC] 刻意**不含 username**：username 是登录标识，把它随在线列表发出去
 *       等于给暴力破解 / 撞库递上用户名清单。前端只用到 id / nickname / avatar。
 */
function onlineList() {
  return Array.from(onlineUsers.values()).map((u) => ({
    id: u.id, nickname: u.nickname, avatar: u.avatar || ''
  }));
}

/**
 * 某个用户能看到的在线列表。
 *   默认（security.presence.scope: related）= 只含自己 + 好友 + 同群成员；
 *   scope: all = 旧行为（全站），仅在你明确接受「在线列表＝用户枚举通道」时开启。
 */
function onlineListFor(userId) {
  const all = onlineList();
  if (PRESENCE_ALL || userId === undefined || userId === null) return all;
  const visible = helpers.relatedUserIds(userId);
  return all.filter((u) => visible.has(Number(u.id)));
}

/**
 * [PERF] 批量构建「每个在线用户各自可见的名单」：
 *   原实现：对每个在线用户调一次 helpers.relatedUserIds() = N × 3 次 SQL。
 *   现实现：3 次 SQL 一次性把所有用户的关系网取出来，内存里分派。
 *
 * 覆盖三类关系（与 helpers.relatedUserIds 语义一致）：
 *   1) 自己
 *   2) 好友（双向）
 *   3) 同群成员（双向）
 */
function buildVisibilityMap() {
  const ids = Array.from(onlineUsers.keys()).map(Number);
  const map = new Map();
  for (const id of ids) map.set(id, new Set([id]));

  if (ids.length === 0) return map;
  if (PRESENCE_ALL) return map;

  const ph = ids.map(() => '?').join(',');

  // 1) 好友关系：user_id 在 ids 里 → 加 friend_id
  const outgoing = db.prepare(
    `SELECT user_id, friend_id FROM friendships WHERE user_id IN (${ph})`
  ).all(...ids);
  for (const r of outgoing) {
    const u = Number(r.user_id);
    const f = Number(r.friend_id);
    if (map.has(u)) map.get(u).add(f);
  }

  // 2) 好友关系：friend_id 在 ids 里 → 加 user_id（反向也要）
  const incoming = db.prepare(
    `SELECT user_id, friend_id FROM friendships WHERE friend_id IN (${ph})`
  ).all(...ids);
  for (const r of incoming) {
    const u = Number(r.user_id);
    const f = Number(r.friend_id);
    if (map.has(f)) map.get(f).add(u);
  }

  // 3) 同群成员
  const myGroups = db.prepare(
    `SELECT group_id, user_id FROM group_members WHERE user_id IN (${ph})`
  ).all(...ids);
  const groupIds = [...new Set(myGroups.map((r) => r.group_id))];
  if (groupIds.length > 0) {
    const gph = groupIds.map(() => '?').join(',');
    const peers = db.prepare(
      `SELECT group_id, user_id FROM group_members WHERE group_id IN (${gph})`
    ).all(...groupIds);
    const byGroup = new Map();
    for (const r of peers) {
      if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []);
      byGroup.get(r.group_id).push(Number(r.user_id));
    }
    for (const r of myGroups) {
      const u = Number(r.user_id);
      if (!map.has(u)) continue;
      for (const p of byGroup.get(r.group_id) || []) map.get(u).add(p);
    }
  }

  return map;
}

function broadcastOnline() {
  if (!io) return;
  const all = onlineList();
  if (PRESENCE_ALL) {
    io.emit('users:online', all);
    return;
  }
  const visibility = buildVisibilityMap();
  for (const u of onlineUsers.values()) {
    const visible = visibility.get(Number(u.id)) || new Set([u.id]);
    const list = all.filter((x) => visible.has(Number(x.id)));
    for (const sid of u.sockets) io.to(sid).emit('users:online', list);
  }
}

function sendTo(userId, event, data) {
  if (!io) return;
  const u = onlineUsers.get(Number(userId));
  if (!u) return;
  for (const sid of u.sockets) io.to(sid).emit(event, data);
}

function emitToRoom(roomType, roomId, event, data) {
  if (!io) return;
  const ids = helpers.getRoomMemberIds(roomType, roomId);
  if (ids === null) { io.emit(event, data); return; }
  for (const uid of ids) sendTo(uid, event, data);
}

function broadcastAll(event, data) {
  if (io) io.emit(event, data);
}

module.exports = {
  init, getIo, getOnlineCount, getOnlineUsers,
  addSocket, removeSocket,
  onlineList, onlineListFor, broadcastOnline, broadcastAll,
  sendTo, emitToRoom
};