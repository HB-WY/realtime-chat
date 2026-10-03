// src/services/redpackets.js
//
// 群 / 私聊红包。两种模式：
//   · lucky（拼手气）—— 每份金额随机；用二倍均值法
//   · fixed（普通）  —— 每份等额
//
// 资金流转（托管到 OFFICIAL_USER_ID）：
//   发送：发送者 -总额，官方 +总额
//   领取：官方 -本次，领取者 +本次
//   过期：官方 -剩余，发送者 +剩余
//
// 拼手气算法（二倍均值法，与微信一致）：
//   每次抢的范围是 [min_amount, 剩余金额 / 剩余人数 × 2]
//   最后一人拿剩余的全部
//   单份下限 min_amount_per_pack（保证每份不为 0）
//
// 与消息的整合：发送时同时插一条 messages（ref_type='red_packet'）。
//
const { db, OFFICIAL_USER_ID } = require('../db');
const { transaction } = require('../db/tx');
const { changePoints } = require('./points');
const config = require('../config');

const CFG = config.PAYMENTS_CFG.redpacket;
const TRANSFER_CFG = config.PAYMENTS_CFG.transfer;

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function toDto(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    roomType: row.room_type,
    roomId: row.room_id,
    totalAmount: row.total_amount,
    totalCount: row.total_count,
    remainingAmount: row.remaining_amount,
    remainingCount: row.remaining_count,
    mode: row.mode,
    note: row.note || '',
    status: row.status,
    messageId: row.message_id || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    emptiedAt: row.emptied_at || null,
    ...extra
  };
}

function assertDailyQuota(userId, amount) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  // [FIX] 口径改为「净流出」：expired 的转账 / 红包都已自动退回，不占额度
  const t = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transfers
      WHERE from_id = ? AND created_at >= ? AND status NOT IN ('rejected', 'expired')`
  ).get(userId, start.getTime()).total;
  const r = db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS total FROM red_packets
      WHERE sender_id = ? AND created_at >= ? AND status != 'expired'`
  ).get(userId, start.getTime()).total;
  const used = (t || 0) + (r || 0);
  if (used + amount > TRANSFER_CFG.daily_limit) {
    throw fail(`今日发出额度不足（已用 ${used} / 上限 ${TRANSFER_CFG.daily_limit}）`);
  }
}

/**
 * 校验 roomType / roomId，并确保发送者有权在该房间发言。
 * 这里只做「房间类型 + 成员身份」的基础校验，与 chat.assertRoomAccess 口径一致。
 */
function checkRoomAccess(userId, roomType, roomId) {
  if (!['private', 'group'].includes(roomType)) {
    throw fail('红包只能在私聊或群聊里发');
  }
  if (roomType === 'private') {
    const parts = String(roomId).replace(/^p_/, '').split('_').map(Number);
    if (!parts.includes(userId)) throw fail('无权在该会话发红包', 403);
    return parts;
  }
  const gid = Number(String(roomId).replace(/^g_/, ''));
  const ok = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(gid, userId);
  if (!ok) throw fail('你不是该群成员', 403);
  return [gid];
}

// ============================================================
// 拼手气金额抽样（二倍均值法）
// 返回 { amount, isLast } —— isLast=true 时 amount 就是剩余全部
// ============================================================
function pickLuckyAmount(remainingAmount, remainingCount) {
  // 最后一份：直接拿走剩余全部
  if (remainingCount <= 1) return remainingAmount;
  const avg = remainingAmount / remainingCount;
  const maxThis = Math.floor(avg * 2);
  const minThis = CFG.min_amount_per_pack;
  // 剩余金额不够再分时，退化为固定 1/剩余人数（保证每份 >= min）
  const high = Math.max(minThis, Math.min(maxThis, remainingAmount - minThis * (remainingCount - 1)));
  const span = Math.max(0, high - minThis);
  const pick = minThis + Math.floor(Math.random() * (span + 1));
  // 不变量：pick 已保证 <= 剩余金额 - 其余各份的保底，这里再夹一次防越界
  return Math.min(pick, remainingAmount - minThis * (remainingCount - 1));
}

// ============================================================
// 发红包
// ============================================================
const createImpl = (senderUser, { roomType, roomId, totalAmount, count, mode, note }) => {
  const senderId = senderUser.id;
  const total = Number(totalAmount);
  const cnt = Number(count);
  const m = mode === 'fixed' ? 'fixed' : 'lucky';

  if (!Number.isInteger(total) || total < 1 || total > CFG.max_amount) {
    throw fail(`红包总额需为 1-${CFG.max_amount} 的整数`);
  }
  if (!Number.isInteger(cnt) || cnt < 1 || cnt > CFG.max_count) {
    throw fail(`红包份数需为 1-${CFG.max_count} 的整数`);
  }
  // 每份不低于最低额
  if (total < cnt * CFG.min_amount_per_pack) {
    throw fail(`总额不足以分成 ${cnt} 份（每份至少 ${CFG.min_amount_per_pack}）`);
  }
  // 私聊红包：只能一份（一对一，语义上就是"给对方一个红包"）
  if (roomType === 'private' && cnt !== 1) {
    throw fail('私聊红包只能 1 份');
  }

  checkRoomAccess(senderId, roomType, roomId);
  assertDailyQuota(senderId, total);

  const noteStr = (note || '').toString().trim().slice(0, CFG.note_max_len);
  const now = Date.now();
  const expiresAt = now + CFG.expire_hours * 3600 * 1000;

  // 发送者 -总额，官方 +总额（托管）
  changePoints(senderId, -total, 'redpacket_send', 'red_packet', null, `共 ${cnt} 份`);
  changePoints(OFFICIAL_USER_ID, +total, 'redpacket_hold', 'red_packet', null, `由 #${senderId} 托管`);

  const info = db.prepare(
    `INSERT INTO red_packets
       (sender_id, room_type, room_id, total_amount, total_count,
        remaining_amount, remaining_count, mode, note, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(senderId, roomType, roomId, total, cnt, total, cnt, m, noteStr, now, expiresAt);
  const redPacketId = Number(info.lastInsertRowid);

  // 插一条聊天消息（text 为空，靠 ref_type/ref_id 渲染红包卡片）
  const msgId = `${now}-${Math.random().toString(36).slice(2, 9)}`;
  db.prepare(
    `INSERT INTO messages
       (id, room_type, room_id, sender_id, sender_name, sender_avatar, text,
        ref_type, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'red_packet', ?, ?)`
  ).run(
    msgId, roomType, roomId,
    senderId, senderUser.nickname, senderUser.avatar || '',
    redPacketId, now
  );

  db.prepare('UPDATE red_packets SET message_id = ? WHERE id = ?').run(msgId, redPacketId);

  const row = db.prepare('SELECT * FROM red_packets WHERE id = ?').get(redPacketId);
  return {
    redPacket: toDto(row),
    messageId: msgId,
    sender: { id: senderId, nickname: senderUser.nickname, avatar: senderUser.avatar || '' }
  };
};

const create = transaction(createImpl);

// ============================================================
// 抢红包
// ============================================================
const grabImpl = (userId, redPacketId) => {
  const row = db.prepare('SELECT * FROM red_packets WHERE id = ?').get(Number(redPacketId));
  if (!row) throw fail('红包不存在', 404);
  if (row.status !== 'active') throw fail('红包已领完或已过期');
  if (Date.now() > row.expires_at) throw fail('红包已过期');

  // 发送者不能抢自己的红包（其实微信也是"不能"，但物理上他可以点开看；
  // 我们这里直接禁止，简单明确）
  if (row.sender_id === userId) throw fail('不能抢自己发的红包');

  // 房间访问权（抢的时候还在不在群里）
  checkRoomAccess(userId, row.room_type, row.room_id);

  // 已抢过
  const existing = db.prepare(
    'SELECT * FROM red_packet_grants WHERE red_packet_id = ? AND user_id = ?'
  ).get(row.id, userId);
  if (existing) throw fail('你已经抢过这个红包了');

  // 计算本次金额
  const remainingCount = row.remaining_count;
  const remainingAmount = row.remaining_amount;
  // [FIX] 固定模式：最后一份直接拿走全部剩余，整除零头并入最后一份。
  //   原实现每份 Math.floor(total/count) 且最后一份 Math.min 封顶，
  //   不能整除时零头会永久滞留在官方托管账户（status='empty' 后
  //   过期扫描只处理 'active'，永远不会退回发送者）。
  const amount = row.mode === 'fixed'
    ? (remainingCount === 1
        ? remainingAmount
        : Math.floor(row.total_amount / row.total_count))
    : pickLuckyAmount(remainingAmount, remainingCount);

  const finalAmount = Math.min(amount, remainingAmount);

  // 官方 → 领取者
  changePoints(OFFICIAL_USER_ID, -finalAmount, 'redpacket_release', 'red_packet', row.id, `→ #${userId}`);
  changePoints(userId, +finalAmount, 'redpacket_receive', 'red_packet', row.id,
    `来自 #${row.sender_id} 的红包`);

  // 记录 grant
  db.prepare(
    `INSERT INTO red_packet_grants (red_packet_id, user_id, amount, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(row.id, userId, finalAmount, Date.now());

  // 更新剩余
  const newRemainingAmount = remainingAmount - finalAmount;
  const newRemainingCount = remainingCount - 1;
  const empty = newRemainingCount <= 0 || newRemainingAmount <= 0;

  db.prepare(
    `UPDATE red_packets
       SET remaining_amount = ?, remaining_count = ?,
           status = ?, emptied_at = ?
     WHERE id = ?`
  ).run(
    newRemainingAmount, newRemainingCount,
    empty ? 'empty' : 'active',
    empty ? Date.now() : null,
    row.id
  );

  const fresh = db.prepare('SELECT * FROM red_packets WHERE id = ?').get(row.id);
  return {
    redPacket: toDto(fresh),
    amount: finalAmount,
    emptied: empty
  };
};

const grab = transaction(grabImpl);

// ============================================================
// 查询
// ============================================================
function getById(userId, redPacketId) {
  const row = db.prepare('SELECT * FROM red_packets WHERE id = ?').get(Number(redPacketId));
  if (!row) return null;
  // 权限：能访问该房间就能看（红包详情本就是群里大家看）
  try {
    checkRoomAccess(userId, row.room_type, row.room_id);
  } catch {
    // 私聊红包允许发送者本人查看
    if (row.sender_id !== userId) return null;
  }

  const sender = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?')
    .get(row.sender_id);

  const grants = db.prepare(
    `SELECT g.user_id AS userId, g.amount, g.created_at AS createdAt,
            u.nickname, u.avatar
       FROM red_packet_grants g
       LEFT JOIN users u ON u.id = g.user_id
      WHERE g.red_packet_id = ?
      ORDER BY g.created_at ASC`
  ).all(row.id);

  const myGrant = grants.find((g) => g.userId === userId) || null;

  return toDto(row, {
    sender: sender ? { id: sender.id, nickname: sender.nickname, avatar: sender.avatar || '' } : null,
    grants,
    myGrant
  });
}

function listMine(userId, role = 'all', limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let rows;
  if (role === 'send') {
    rows = db.prepare(
      `SELECT * FROM red_packets WHERE sender_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(userId, lim);
  } else if (role === 'receive') {
    rows = db.prepare(
      `SELECT rp.* FROM red_packets rp
       JOIN red_packet_grants g ON g.red_packet_id = rp.id
       WHERE g.user_id = ? ORDER BY g.created_at DESC LIMIT ?`
    ).all(userId, lim);
  } else {
    rows = db.prepare(
      `SELECT DISTINCT rp.* FROM red_packets rp
        LEFT JOIN red_packet_grants g ON g.red_packet_id = rp.id
        WHERE rp.sender_id = ? OR g.user_id = ?
        ORDER BY rp.created_at DESC LIMIT ?`
    ).all(userId, userId, lim);
  }
  return rows.map((r) => toDto(r));
}

// ============================================================
// 过期扫描：剩的钱退给发送者
// ============================================================
const sweepExpiredImpl = () => {
  const now = Date.now();
  const rows = db.prepare(
    `SELECT * FROM red_packets
      WHERE status = 'active' AND expires_at <= ? LIMIT 100`
  ).all(now);

  // [FIX] 历史遗留：修复前的固定红包可能以 status='empty' 且
  //       remaining_amount > 0 结束（零头滞留托管账户），这里一并退还。
  const leftover = db.prepare(
    `SELECT * FROM red_packets
      WHERE status = 'empty' AND remaining_amount > 0 LIMIT 100`
  ).all();

  const settled = [];
  for (const row of [...rows, ...leftover]) {
    const remain = row.remaining_amount;
    if (remain > 0) {
      changePoints(OFFICIAL_USER_ID, -remain, 'redpacket_release', 'red_packet', row.id, `过期退回 #${row.sender_id}`);
      changePoints(row.sender_id, +remain, 'redpacket_refund', 'red_packet', row.id, `${row.remaining_count} 份未领完`);
    }
    const finalStatus = row.status === 'empty' ? 'empty' : 'expired';
    db.prepare(
      `UPDATE red_packets SET status = ?, remaining_amount = 0, emptied_at = ? WHERE id = ?`
    ).run(finalStatus, now, row.id);
    settled.push(toDto({ ...row, status: finalStatus, emptied_at: now }));
  }
  return settled;
};

const sweepExpired = transaction(sweepExpiredImpl);

module.exports = {
  create, grab, getById, listMine, sweepExpired,
  toDto,
};
