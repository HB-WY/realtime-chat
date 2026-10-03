// src/services/transfers.js
//
// 一对一转账（微信式「待收款」语义）。
//
// 资金流转：
//   发起：from -amount，官方 +amount（托管）
//   收款：官方 -amount，to +amount
//   退还/超时：官方 -amount，from +amount
//
// 幂等键：无（一次转账就是一次操作，重复发是两笔）
// 事务：本文件全程用 transaction() 包裹（内部 changePoints 会走 SAVEPOINT），
//       保证「状态更新 + 流水」两处一致。
//
// 与消息的整合：发起时同时插一条 messages（ref_type='transfer',
// ref_id=transferId），text 为空。前端 MessageBubble 见到 ref_type 就
// 渲染转账卡片。
//
const { db, OFFICIAL_USER_ID } = require('../db');
const { transaction } = require('../db/tx');
const { changePoints } = require('./points');
const config = require('../config');

const CFG = config.PAYMENTS_CFG.transfer;
const CHAT = require('./chat');   // 用于 assertRoomAccess

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function toDto(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    amount: row.amount,
    note: row.note || '',
    status: row.status,
    messageId: row.message_id || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    settledAt: row.settled_at || null,
    ...extra
  };
}

/** 每次只允许发一次，达到上限就报错；isTransfer / isRedPacket 用来把两类
 *  的今日支出合并计数（避免"转账 50000 + 红包 50000"绕过 daily_limit）。
 *
 * [FIX] 口径改为「净流出」：已退回的资金不再占用当日额度。
 *   转账排除 rejected **和 expired**（超时自动退回）；红包排除 expired
 *   （未领完部分已自动退回发送者）。原先退款后额度照样虚耗，误伤正常用户。
 */
function assertDailyQuota(userId, amount) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transfers
      WHERE from_id = ? AND created_at >= ? AND status NOT IN ('rejected', 'expired')`
  ).get(userId, start.getTime()).total;
  const r = db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS total FROM red_packets
      WHERE sender_id = ? AND created_at >= ? AND status != 'expired'`
  ).get(userId, start.getTime()).total;
  const used = (t || 0) + (r || 0);
  if (used + amount > CFG.daily_limit) {
    throw fail(`今日发出额度不足（已用 ${used} / 上限 ${CFG.daily_limit}）`);
  }
}

function privateRoomId(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `p_${x}_${y}`;
}

// ============================================================
// 发起
// ============================================================
const createImpl = (fromUser, { toUserId, amount, note }) => {
  const fromId = fromUser.id;
  const toId = Number(toUserId);

  if (!Number.isInteger(amount) || amount < CFG.min_amount || amount > CFG.max_amount) {
    throw fail(`转账金额需为 ${CFG.min_amount}-${CFG.max_amount} 的整数`);
  }
  if (!toId || toId === fromId) throw fail('不能给自己转账');

  const to = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ? AND status = ?')
    .get(toId, 'active');
  if (!to) throw fail('收款人不存在或已被禁用', 404);

  const noteStr = (note || '').toString().trim().slice(0, CFG.note_max_len);

  assertDailyQuota(fromId, amount);

  const now = Date.now();
  const expiresAt = now + CFG.expire_hours * 3600 * 1000;

  // 消息与转账同事务：先扣款，再落两行，一起提交
  const roomType = 'private';
  const roomId = privateRoomId(fromId, toId);

  // 走聊天权限（虽然是自己拼的 roomId，但保持统一入口）。
  // [FIX] 不再整体吞错：roomId 由 fromId/toId 拼出，fromId 必在其中，
  //       正常情况下不会抛；真抛了说明参数异常，应该让转账失败而不是静默放行。
  CHAT.assertRoomAccess(fromId, roomType, roomId, { forSend: true });

  // 扣款 + 托管（两笔流水）
  changePoints(fromId, -amount, 'transfer_send', 'transfer', null, `→ ${to.nickname}`);
  changePoints(OFFICIAL_USER_ID, +amount, 'transfer_hold', 'transfer', null, `由 #${fromId} 托管`);

  // 插转账记录
  const info = db.prepare(
    `INSERT INTO transfers
       (from_id, to_id, amount, note, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(fromId, toId, amount, noteStr, now, expiresAt);
  const transferId = Number(info.lastInsertRowid);

  // 插一条聊天消息（text 为空，靠 ref_type/ref_id 渲染转账卡片）
  const msgId = `${now}-${Math.random().toString(36).slice(2, 9)}`;
  db.prepare(
    `INSERT INTO messages
       (id, room_type, room_id, sender_id, sender_name, sender_avatar, text,
        ref_type, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'transfer', ?, ?)`
  ).run(
    msgId, roomType, roomId,
    fromId, fromUser.nickname, fromUser.avatar || '',
    transferId, now
  );

  db.prepare('UPDATE transfers SET message_id = ? WHERE id = ?').run(msgId, transferId);

  // 双端都能看到这条消息
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  return {
    transfer: toDto(row),
    messageId: msgId,
    fromUser: { id: fromId, nickname: fromUser.nickname, avatar: fromUser.avatar || '' },
    toUser: { id: to.id, nickname: to.nickname, avatar: to.avatar || '' }
  };
};

const create = transaction(createImpl);

// ============================================================
// 收款 / 退还
// ============================================================
const acceptImpl = (userId, transferId) => {
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(Number(transferId));
  if (!row) throw fail('转账不存在', 404);
  if (row.to_id !== userId) throw fail('无权操作该转账', 403);
  if (row.status !== 'pending') throw fail('该转账已结束');
  if (Date.now() > row.expires_at) throw fail('该转账已过期');

  // 官方 → 收款人
  changePoints(OFFICIAL_USER_ID, -row.amount, 'transfer_release', 'transfer', row.id, `→ 收款 #${userId}`);
  changePoints(userId, +row.amount, 'transfer_accept', 'transfer', row.id, `来自 #${row.from_id}`);

  db.prepare('UPDATE transfers SET status = ?, settled_at = ? WHERE id = ?')
    .run('accepted', Date.now(), row.id);

  const fresh = db.prepare('SELECT * FROM transfers WHERE id = ?').get(row.id);
  return { transfer: toDto(fresh) };
};

const accept = transaction(acceptImpl);

const rejectImpl = (userId, transferId) => {
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(Number(transferId));
  if (!row) throw fail('转账不存在', 404);
  if (row.to_id !== userId) throw fail('无权操作该转账', 403);
  if (row.status !== 'pending') throw fail('该转账已结束');

  // 官方 → 发送者
  changePoints(OFFICIAL_USER_ID, -row.amount, 'transfer_release', 'transfer', row.id, `→ 退还 #${row.from_id}`);
  changePoints(row.from_id, +row.amount, 'transfer_refund', 'transfer', row.id, `由 #${userId} 退还`);

  db.prepare('UPDATE transfers SET status = ?, settled_at = ? WHERE id = ?')
    .run('rejected', Date.now(), row.id);

  const fresh = db.prepare('SELECT * FROM transfers WHERE id = ?').get(row.id);
  return { transfer: toDto(fresh) };
};

const reject = transaction(rejectImpl);

// ============================================================
// 查询
// ============================================================
function getById(userId, transferId) {
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(Number(transferId));
  if (!row) return null;
  if (row.from_id !== userId && row.to_id !== userId) return null;

  const from = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(row.from_id);
  const to = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(row.to_id);
  return toDto(row, {
    fromUser: from ? { id: from.id, nickname: from.nickname, avatar: from.avatar || '' } : null,
    toUser: to ? { id: to.id, nickname: to.nickname, avatar: to.avatar || '' } : null
  });
}

function listMine(userId, role = 'all', limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let sql;
  let args;
  if (role === 'send') {
    sql = `SELECT * FROM transfers WHERE from_id = ? ORDER BY created_at DESC LIMIT ?`;
    args = [userId, lim];
  } else if (role === 'receive') {
    sql = `SELECT * FROM transfers WHERE to_id = ? ORDER BY created_at DESC LIMIT ?`;
    args = [userId, lim];
  } else {
    sql = `SELECT * FROM transfers WHERE from_id = ? OR to_id = ?
           ORDER BY created_at DESC LIMIT ?`;
    args = [userId, userId, lim];
  }
  const rows = db.prepare(sql).all(...args);
  return rows.map((r) => {
    const from = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(r.from_id);
    const to = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(r.to_id);
    return toDto(r, {
      fromUser: from ? { id: from.id, nickname: from.nickname, avatar: from.avatar || '' } : null,
      toUser: to ? { id: to.id, nickname: to.nickname, avatar: to.avatar || '' } : null
    });
  });
}

// ============================================================
// 过期扫描：把 status='pending' 且已过期的转账退回发送者
// 由 services/payments_expiry.js 统一调度。
// ============================================================
const sweepExpiredImpl = () => {
  const now = Date.now();
  const rows = db.prepare(
    `SELECT * FROM transfers WHERE status = 'pending' AND expires_at <= ? LIMIT 100`
  ).all(now);

  const settled = [];
  for (const row of rows) {
    // 官方 → 发送者
    changePoints(OFFICIAL_USER_ID, -row.amount, 'transfer_release', 'transfer', row.id, `超时退回 #${row.from_id}`);
    changePoints(row.from_id, +row.amount, 'transfer_refund', 'transfer', row.id, '24h 未收款，自动退回');
    db.prepare('UPDATE transfers SET status = ?, settled_at = ? WHERE id = ?')
      .run('expired', now, row.id);
    settled.push(toDto({ ...row, status: 'expired', settled_at: now }));
  }
  return settled;
};

const sweepExpired = transaction(sweepExpiredImpl);

module.exports = {
  create, accept, reject, getById, listMine, sweepExpired,
  toDto,
};
