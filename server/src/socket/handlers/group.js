// src/socket/handlers/group.js
//
// 群聊相关 socket 事件。业务逻辑在 services/chat.js。
//
const { makeRateLimiter } = require('../helpers');
const chat = require('../../services/chat');

module.exports = function registerGroupHandlers(socket) {
  const user = socket.user;
  const allowWrite = makeRateLimiter('write');

  socket.on('group:create', ({ name, memberIds } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      const out = chat.createGroup(user, name, memberIds);
      ack?.({ ok: true, groupId: out.groupId });
    } catch (err) {
      ack?.({ error: err.message || '创建失败' });
    }
  });

  socket.on('group:request', ({ groupId } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      chat.requestJoinGroup(user, groupId);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ error: err.message || '申请失败' });
    }
  });

  socket.on('group:approve', ({ requestId } = {}) => {
    try { chat.approveGroupRequest(user, requestId); } catch { /* 忽略 */ }
  });

  socket.on('group:reject', ({ requestId } = {}) => {
    try { chat.rejectGroupRequest(user, requestId); } catch { /* 忽略 */ }
  });

  socket.on('group:invite', ({ groupId, userId: targetId } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      chat.inviteToGroup(user, groupId, targetId);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ error: err.message || '邀请失败' });
    }
  });

  socket.on('group:leave', ({ groupId } = {}) => {
    try { chat.leaveGroup(user, groupId); } catch { /* 忽略 */ }
  });

  socket.on('group:kick', ({ groupId, userId: targetId } = {}, ack) => {
    try {
      chat.kickFromGroup(user, groupId, targetId);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ error: err.message || '移除失败' });
    }
  });

  socket.on('group:info', ({ groupId } = {}, ack) => {
    try {
      ack?.({ ok: true, group: chat.getGroupInfo(user, groupId) });
    } catch (err) {
      ack?.({ error: err.message || '群不存在' });
    }
  });

  // 修改群资料：群名（群主）/ 群图标（群主 + 群管理员）
  socket.on('group:update', ({ groupId, name, avatar } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (avatar !== undefined) patch.avatar = avatar;
      ack?.({ ok: true, group: chat.updateGroup(user, groupId, patch) });
    } catch (err) {
      ack?.({ error: err.message || '修改失败' });
    }
  });

  // 任免群管理员（仅群主）
  socket.on('group:member:role', ({ groupId, userId: targetId, role } = {}, ack) => {
    if (!allowWrite(user.id)) return ack?.({ error: '操作太频繁，请稍后再试' });
    try {
      const out = chat.setGroupMemberRole(user, groupId, targetId, role);
      ack?.({ ok: true, group: out.group });
    } catch (err) {
      ack?.({ error: err.message || '设置失败' });
    }
  });
};
