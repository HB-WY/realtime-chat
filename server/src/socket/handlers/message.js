// src/socket/handlers/message.js
//
// 消息相关 socket 事件。业务逻辑全部在 services/chat.js，
// REST（API 密钥通道）复用同一套实现。
//
const { db } = require('../../db');
const { makeRateLimiter } = require('../helpers');
const chat = require('../../services/chat');

module.exports = function registerMessageHandlers(socket, ctx) {
  const { sendTo, isGroupMember } = ctx;
  const user = socket.user;
  const allowMsg = makeRateLimiter('message');

  socket.on('room:open', ({ roomType, roomId } = {}, ack) => {
    if (!roomType || !roomId) return;
    try {
      chat.assertRoomAccess(user.id, roomType, roomId);
    } catch (err) {
      // [FIX] 鉴权失败不再静默：客户端至少要知道为什么拿不到历史
      ack?.({ error: err.message || '无权访问该会话' });
      return;
    }
    socket.emit('messages:history', {
      roomType, roomId, messages: chat.loadHistory(user.id, roomType, roomId)
    });
  });

  socket.on('message:send', (data, ack) => {
    if (!allowMsg(user.id)) {
      if (typeof ack === 'function') ack({ error: '发送太频繁，请稍后再试' });
      return;
    }
    try {
      const msg = chat.sendMessage(user, data || {});
      if (typeof ack === 'function') ack({ ok: true, id: msg.id });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || '发送失败' });
    }
  });

  socket.on('message:read', (messageId) => {
    if (!allowMsg(user.id)) return; // [FIX] 补限流：写库操作不该无限流
    try { chat.markRead(user, messageId); } catch { /* 忽略 */ }
  });

  socket.on('message:recall', (messageId, ack) => {
    try {
      chat.recallMessage(user, messageId);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || '撤回失败' });
    }
  });

  const emitTyping = (roomType, roomId, isTyping) => {
    // [SEC] 畸形 payload（如 private 但缺 roomId）会让下面的 roomId.replace 抛错；
    //       早期会直接变成 uncaughtException 打崩进程，这里先做参数校验。
    if (!roomType || typeof roomId !== 'string' || !roomId) return;

    const payload = { roomType, roomId, userId: user.id, nickname: user.nickname, isTyping };
    if (roomType === 'public') socket.broadcast.emit('typing:update', payload);
    else if (roomType === 'private') {
      const parts = roomId.replace(/^p_/, '').split('_').map(Number);
      // [SEC] 必须确认发送者本人就在这个私聊里，否则任何人都能用
      //       {roomType:'private', roomId:'p_<a>_<b>'} 向任意两人的会话
      //       注入伪造的「正在输入」。
      if (!parts.includes(user.id)) return;
      for (const uid of parts) if (uid !== user.id) sendTo(uid, 'typing:update', payload);
    } else if (roomType === 'group') {
      const gid = Number(roomId.replace(/^g_/, ''));
      if (!isGroupMember(gid, user.id)) return;
      const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid);
      for (const m of members) if (m.user_id !== user.id) sendTo(m.user_id, 'typing:update', payload);
    }
  };

  socket.on('typing:start', ({ roomType, roomId } = {}) => emitTyping(roomType, roomId, true));
  socket.on('typing:stop',  ({ roomType, roomId } = {}) => emitTyping(roomType, roomId, false));
};
