// src/socket/handlers/presence.js
//
// 【本次改动】user:updated 广播去掉 username：
//   原先 io.emit('user:updated', {... username ...}) 会把用户名全站广播，
//   与 registry.onlineList() 刻意省略 username 的策略自相矛盾 —— 改一次昵称
//   就等于向全站每位在线用户派发一份用户名清单（F-05 收敛策略的绕过路径）。
//   前端 ChatRoom 的 onUserUpdated 只用 id/nickname/avatar/role，去掉无影响。
//
const { db } = require('../../db');
const chat = require('../../services/chat');
const { makeRateLimiter } = require('../helpers');

module.exports = function registerPresenceHandlers(socket, ctx) {
  const { io, onlineUsers, broadcastOnline } = ctx;
  const user = socket.user;

  // [FIX] 补限流：search 每次两条全表 instr 查询；user:refresh 每次触发
  //       O(在线用户数) 的全站广播 —— 高频调用是现成的放大器。
  //       presence 类事件走独立预算（rate_limits.socket.presence），
  //       不占用 write 额度：正常客户端会频繁搜索 / 刷新。
  const allowSearch = makeRateLimiter('presence');
  const allowRefresh = makeRateLimiter('presence');

  socket.on('users:search', ({ keyword } = {}, ack) => {
    if (!allowSearch(user.id)) return ack?.({ error: '搜索太频繁，请稍后再试' });
    ack?.({ ok: true, users: chat.searchUsers(user, keyword) });
  });

  socket.on('groups:search', ({ keyword } = {}, ack) => {
    if (!allowSearch(user.id)) return ack?.({ error: '搜索太频繁，请稍后再试' });
    ack?.({ ok: true, groups: chat.searchGroups(user, keyword) });
  });

  socket.on('user:refresh', () => {
    if (!allowRefresh(user.id)) return;
    const row = db.prepare(
      'SELECT id, username, nickname, avatar, signature, role, status FROM users WHERE id = ?'
    ).get(user.id);
    if (!row) return;
    if (row.status !== 'active') { socket.disconnect(true); return; }

    socket.user.nickname = row.nickname;
    socket.user.avatar = row.avatar || '';
    socket.user.signature = row.signature || '';
    socket.user.role = row.role || 'user';

    const e = onlineUsers?.get(user.id);
    if (e) {
      e.nickname = row.nickname;
      e.avatar = row.avatar || '';
      e.role = row.role || 'user';
    }
    broadcastOnline();
    // [SEC] 全站广播**不含 username**（signature 是展示文本，随昵称一并同步）
    io.emit('user:updated', {
      id: row.id,
      nickname: row.nickname,
      avatar: row.avatar || '',
      signature: row.signature || '',
      role: row.role || 'user'
    });
  });
};