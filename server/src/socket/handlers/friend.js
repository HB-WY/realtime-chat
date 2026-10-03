// src/socket/handlers/friend.js
//
// 好友相关 socket 事件。业务逻辑在 services/chat.js。
//
const { makeRateLimiter } = require('../helpers');
const chat = require('../../services/chat');

module.exports = function registerFriendHandlers(socket) {
  const user = socket.user;
  const allowWrite = makeRateLimiter('write');

  socket.on('friend:request', ({ username } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      chat.requestFriend(user, username);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ error: err.message || '操作失败' });
    }
  });

  socket.on('friend:accept', ({ requestId } = {}) => {
    try { chat.acceptFriendRequest(user, requestId); } catch { /* 忽略 */ }
  });

  socket.on('friend:reject', ({ requestId } = {}) => {
    try { chat.rejectFriendRequest(user, requestId); } catch { /* 忽略 */ }
  });

  socket.on('friend:remove', ({ friendId } = {}) => {
    try { chat.removeFriend(user, friendId); } catch { /* 忽略 */ }
  });
};
