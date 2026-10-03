// src/socket/handlers/room.js
//
// 房间设置相关 socket 事件。业务逻辑在 services/rooms.js。
//
const { makeRateLimiter } = require('../helpers');
const rooms = require('../../services/rooms');

module.exports = function registerRoomHandlers(socket) {
  const user = socket.user;
  const allowWrite = makeRateLimiter('write');

  // 公共聊天房信息（图标）
  socket.on('room:public:get', (_payload, ack) => {
    try {
      ack?.({ ok: true, room: rooms.getPublicRoom() });
    } catch (err) {
      ack?.({ error: err.message || '读取失败' });
    }
  });

  // 更换公共聊天图标（仅开发者，服务端校验）
  socket.on('room:public:icon', ({ icon } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      ack?.({ ok: true, room: rooms.setPublicRoomIcon(user, icon) });
    } catch (err) {
      ack?.({ error: err.message || '设置失败' });
    }
  });
};
