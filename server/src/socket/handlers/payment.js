// src/socket/handlers/payment.js
//
// 支付系统（转账 / 红包）的 socket 事件。
// 业务逻辑全部在 services/transfers.js 与 services/redpackets.js。
//
// 与 REST 等价（/api/transfers / /api/redpackets），保持两条通道行为一致。
// 服务端 handler 一律写成 (payload = {}, ack) => 形式，并做入参类型校验
// （参照 §1.31 的教训：畸形包不允许打崩进程）。
//
const { makeRateLimiter } = require('../helpers');
const transfers = require('../../services/transfers');
const redpackets = require('../../services/redpackets');
const registry = require('../registry');
const config = require('../../config');

// 复用 config.yaml → rate_limits.socket.write 的限流（每 2 秒 1 次、每分钟 60 次）
// 更细的限流（每分钟 10 次）在 services 内部通过 daily_limit + rate_limits.payments 单独控制，
// 这里只是防止单连接爆炸式发送。
const PAYMENTS_CFG = config.PAYMENTS_CFG;

// 支付相关的自有滑动窗口（内存，按 userId）
const hits = new Map();
let ops = 0;
const RL = PAYMENTS_CFG.rate_limit;

function prune() {
  const now = Date.now();
  for (const [uid, arr] of hits) {
    const kept = arr.filter((t) => now - t < RL.window_ms);
    if (kept.length === 0) hits.delete(uid);
    else if (kept.length !== arr.length) hits.set(uid, kept);
  }
}
const pruneTimer = setInterval(prune, 5 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

function allowPay(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < RL.window_ms);
  if (arr.length >= RL.max) {
    hits.set(userId, arr);
    const wait = Math.ceil((RL.window_ms - (now - arr[0])) / 1000);
    return { ok: false, wait };
  }
  arr.push(now);
  hits.set(userId, arr);
  if (++ops >= 500) { ops = 0; prune(); }
  return { ok: true };
}

module.exports = function registerPaymentHandlers(socket) {
  const user = socket.user;

  // ---------------- 转账 ----------------
  socket.on('transfer:send', (payload = {}, ack) => {
    const gate = allowPay(user.id);
    if (!gate.ok) return ack?.({ error: `操作太频繁，请 ${gate.wait} 秒后再试` });
    try {
      const { toUserId, amount, note } = payload || {};
      const out = transfers.create(user, {
        toUserId: Number(toUserId),
        amount: Number(amount),
        note
      });
      // 广播给双方（含发送者自己，便于多端同步）
      const payloadOut = {
        transfer: out.transfer,
        messageId: out.messageId,
        fromUser: out.fromUser,
        toUser: out.toUser
      };
      registry.sendTo(out.transfer.fromId, 'transfer:new', payloadOut);
      registry.sendTo(out.transfer.toId,   'transfer:new', payloadOut);
      ack?.({ ok: true, transfer: out.transfer, messageId: out.messageId });
    } catch (err) {
      ack?.({ error: err.message || '转账失败' });
    }
  });

  socket.on('transfer:accept', ({ transferId } = {}, ack) => {
    try {
      const out = transfers.accept(user.id, transferId);
      registry.sendTo(out.transfer.fromId, 'transfer:accepted', { transfer: out.transfer });
      registry.sendTo(out.transfer.toId,   'transfer:accepted', { transfer: out.transfer });
      ack?.({ ok: true, transfer: out.transfer });
    } catch (err) {
      ack?.({ error: err.message || '收款失败' });
    }
  });

  socket.on('transfer:reject', ({ transferId } = {}, ack) => {
    try {
      const out = transfers.reject(user.id, transferId);
      registry.sendTo(out.transfer.fromId, 'transfer:rejected', { transfer: out.transfer });
      registry.sendTo(out.transfer.toId,   'transfer:rejected', { transfer: out.transfer });
      ack?.({ ok: true, transfer: out.transfer });
    } catch (err) {
      ack?.({ error: err.message || '退还失败' });
    }
  });

  // ---------------- 红包 ----------------
  socket.on('redpacket:send', (payload = {}, ack) => {
    const gate = allowPay(user.id);
    if (!gate.ok) return ack?.({ error: `操作太频繁，请 ${gate.wait} 秒后再试` });
    try {
      const { roomType, roomId, totalAmount, count, mode, note } = payload || {};
      const out = redpackets.create(user, {
        roomType: String(roomType || ''),
        roomId: String(roomId || ''),
        totalAmount: Number(totalAmount),
        count: Number(count),
        mode: mode || 'lucky',
        note
      });
      // 广播到房间（发送者自己也会收到，便于多端同步）
      registry.emitToRoom(roomType, roomId, 'redpacket:new', {
        redPacket: out.redPacket,
        messageId: out.messageId,
        sender: out.sender
      });
      ack?.({ ok: true, redPacket: out.redPacket, messageId: out.messageId });
    } catch (err) {
      ack?.({ error: err.message || '发红包失败' });
    }
  });

  socket.on('redpacket:grab', ({ redPacketId } = {}, ack) => {
    try {
      const out = redpackets.grab(user.id, redPacketId);
      // 广播到房间：谁抢了多少、还剩多少
      registry.emitToRoom(out.redPacket.roomType, out.redPacket.roomId, 'redpacket:grabbed', {
        redPacketId: out.redPacket.id,
        userId: user.id,
        nickname: user.nickname,
        amount: out.amount,
        remainingAmount: out.redPacket.remainingAmount,
        remainingCount: out.redPacket.remainingCount,
        emptied: out.emptied
      });
      ack?.({ ok: true, amount: out.amount, redPacket: out.redPacket, emptied: out.emptied });
    } catch (err) {
      ack?.({ error: err.message || '抢红包失败' });
    }
  });
};
