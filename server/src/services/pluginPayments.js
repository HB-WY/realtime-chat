// src/services/pluginPayments.js
//
// 插件支付：**三层保护**中的服务端一层。
//
//   插件侧（不可信）→ 只能"发起请求"（hostAPI.call('payment.request', {...})）
//   宿主侧（可信）  → 弹宿主的确认框展示金额/余额/卖家，用户同意才继续
//   服务端（可信）  → 在事务里扣买家积分 + 加卖家积分 + 写流水 + 写本表
//
// [SEC] 服务端做三件不可省的事：
//   1) 幂等：UNIQUE(plugin_id, buyer_id, order_id) —— 插件重试不会扣两次
//   2) 事务：扣款/加款要么全成要么全败（changePoints 余额不足会 throw）
//   3) 金额上限：min(manifest.maxPayment, PLUGIN_CFG.payment.max_single)
//      以及**每用户 × 每插件 × 每天的支付笔数上限**（原来是金额上限，
//      见下方 [CHANGED] 说明）
//
// 退款：
//   · 买家可在 refund_window_ms（默认 7 天）内申请自助退款
//   · 管理员不受窗口限制
//   · 退款是反向两笔记账；**卖家余额不足会整体回滚**（不允许负余额）
//
// [CHANGED] 每日限制：金额 → 笔数
//   · 原实现按「当天 paid 金额之和」判 daily_limit，被"支付→退款→再支付"
//     完美绕过：退款后 status='refunded'，不再计入，于是无限循环。
//   · 且金额维度在这个项目里没有实际威胁模型：正常用户一天花不了几笔，
//     恶意插件想套现也得用户一次次点确认框。
//   · 笔数维度是客观事实：退款不减笔数，才真正防住"插件反复弹框"。
//   · 顺带把 transaction_id 的随机从 4 字节提到 8 字节，消除同毫秒 + 随机
//     撞车导致的 UNIQUE 约束失败。
//
const crypto = require('crypto');
const { db } = require('../db');
const { transaction } = require('../db/tx');
const config = require('../config');
const { changePoints, getBalance } = require('./points');
const { audit } = require('./permissions');

const PCFG = config.PLUGIN_CFG;
const PAY_CFG = PCFG.payment;
const RL = config.RATE_LIMITS.plugin_payment || { window_ms: 3600000, max: 30 };

// ============================================================
// 工具
// ============================================================
function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
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

const ORDER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SUBJECT_MAX = 60;

function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ============================================================
// 限流（按用户，内存滑动窗口）
// ============================================================
const hits = new Map();
let ops = 0;
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

function checkRateLimit(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < RL.window_ms);
  if (arr.length >= RL.max) {
    hits.set(userId, arr);
    const wait = Math.ceil((RL.window_ms - (now - arr[0])) / 1000);
    throw fail(`支付请求过于频繁，请 ${wait} 秒后再试`, 429);
  }
  arr.push(now);
  hits.set(userId, arr);
  if (++ops >= 500) { ops = 0; prune(); }
}

// ============================================================
// DTO
// ============================================================
function toDto(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = null; }
  }
  return {
    id: row.id,
    pluginId: row.plugin_id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    amount: row.amount,
    subject: row.subject,
    orderId: row.order_id,
    status: row.status,
    transactionId: row.transaction_id,
    metadata,
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    refundedAt: row.refunded_at || null,
    refundedBy: row.refunded_by || null,
    refundReason: row.refund_reason || null
  };
}

// ============================================================
// [NEW/CHANGED] 每日笔数统计
//
// 计数口径：
//   · 只统计 status IN ('paid', 'refunded') —— 这两者是"实际发生过支付"的
//   · 退款不减笔数（这是本改动能防住循环绕过的核心）
//   · 时间窗：今天 0 点起
//
// 一处实现、两处调用（payInfo 展示 / payImpl 校验），确保口径一致。
// ============================================================
function countTodayPayments(pluginId, buyerId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM plugin_payments
      WHERE plugin_id = ? AND buyer_id = ?
        AND status IN ('paid', 'refunded')
        AND created_at >= ?`
  ).get(pluginId, buyerId, dayStart());
  return row?.n || 0;
}

// ============================================================
// 支付前查询（宿主 UI 用来展示"金额上限 / 余额 / 今日剩余笔数"）
// ============================================================
function payInfo(userId, pluginId, requestedAmount = null) {
  const p = db.prepare(
    'SELECT id, owner_id, name, status, manifest FROM plugins WHERE id = ?'
  ).get(pluginId);
  if (!p) throw notFound('插件不存在');
  if (p.status !== 'active') throw fail('插件已下架');

  let manifest = {};
  try { manifest = JSON.parse(p.manifest) || {}; } catch { /* ignore */ }

  // 单次上限 = min(manifest.maxPayment || default_single, max_single)
  const manifestMax = Number.isInteger(manifest.maxPayment) && manifest.maxPayment > 0
    ? manifest.maxPayment : PAY_CFG.default_single;
  const singleMax = Math.min(manifestMax, PAY_CFG.max_single);

  // [CHANGED] 每日限制：金额 → 笔数
  const usedCount = countTodayPayments(pluginId, userId);
  const countMax = PAY_CFG.max_daily_count_per_plugin;
  const countRemain = Math.max(0, countMax - usedCount);

  const balance = getBalance(userId).balance;

  // [FIX] 若提供了 requestedAmount，就必须完整校验一遍：
  //   原实现是 `if (Number.isFinite(Number(requestedAmount)))` ——
  //   当 requestedAmount 是 "abc" 这种非数字时，Number.isFinite(NaN) 返回
  //   false，整个校验块被跳过，valid 保持初始值 true。宿主 UI 会误以为
  //   金额合法并弹出"确认支付"，然后服务端在 pay() 里拒绝 —— 体验割裂。
  let valid = true;
  let reason = '';
  if (requestedAmount !== null && requestedAmount !== undefined) {
    const amt = Number(requestedAmount);
    if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) {
      valid = false; reason = '金额必须是正整数';
    } else if (amt > singleMax) {
      valid = false; reason = `单次金额不能超过 ${singleMax}`;
    } else if (countRemain <= 0) {
      valid = false; reason = `今日支付次数已达上限（${countMax} 次）`;
    } else if (amt > balance) {
      valid = false; reason = '积分余额不足';
    }
  }

  return {
    pluginId,
    pluginName: p.name,
    sellerId: p.owner_id,
    balance,
    singleMax,
    // [CHANGED] 原字段 dailyRemain（金额）→ 笔数三件套
    dailyCountUsed: usedCount,
    dailyCountMax: countMax,
    dailyCountRemain: countRemain,
    valid,
    reason
  };
}

// ============================================================
// 支付（核心）
// ============================================================
const payImpl = (buyerId, pluginId, { amount, subject, orderId, metadata }) => {
  // ---- 参数校验 ----
  if (!Number.isInteger(amount) || amount <= 0) throw fail('amount 必须是正整数');
  const subj = String(subject || '').trim();
  if (!subj) throw fail('subject 不能为空');
  if (subj.length > SUBJECT_MAX) throw fail(`subject 最多 ${SUBJECT_MAX} 字`);
  const oid = String(orderId || '').trim();
  if (!ORDER_ID_RE.test(oid)) {
    throw fail('orderId 不合法（1-64 位，字母/数字/._:-）');
  }
  if (metadata !== undefined && metadata !== null) {
    const s = JSON.stringify(metadata);
    if (Buffer.byteLength(s, 'utf8') > 2048) throw fail('metadata 过大（>2KB）');
  }

  // ---- 插件校验 ----
  const p = db.prepare(
    'SELECT id, owner_id, name, status, manifest FROM plugins WHERE id = ?'
  ).get(pluginId);
  if (!p) throw notFound('插件不存在');
  if (p.status !== 'active') throw fail('插件已下架');
  if (p.owner_id === buyerId) throw fail('不能向自己的插件付费');

  let manifest = {};
  try { manifest = JSON.parse(p.manifest) || {}; } catch { /* ignore */ }

  // ---- 单次上限 ----
  const manifestMax = Number.isInteger(manifest.maxPayment) && manifest.maxPayment > 0
    ? manifest.maxPayment : PAY_CFG.default_single;
  const singleMax = Math.min(manifestMax, PAY_CFG.max_single);
  if (amount > singleMax) throw fail(`单次金额不能超过 ${singleMax}`);

  // ---- 幂等 ----
  // [FIX] 只把「已支付」当成功：已退款的订单用同一 orderId 重试时，
  //       绝不能回 alreadyPaid（否则退款后免费再拿数字商品）。
  const existing = db.prepare(
    'SELECT * FROM plugin_payments WHERE plugin_id = ? AND buyer_id = ? AND order_id = ?'
  ).get(pluginId, buyerId, oid);
  if (existing) {
    if (existing.status === 'refunded') {
      throw fail('该订单已退款，如需再次购买请使用新的 orderId 重新支付', 409);
    }
    return { ok: true, alreadyPaid: true, payment: toDto(existing), balance: getBalance(buyerId).balance };
  }

  // ---- [CHANGED] 每日笔数上限 ----
  //   从"金额累计"改为"笔数累计"：
  //     · 金额累计容易被"支付→退款→再支付"绕过（退款后 used 归零）
  //     · 笔数是客观事实，退款不减 —— 才真正防住"插件反复弹框"
  const usedCount = countTodayPayments(pluginId, buyerId);
  const countMax = PAY_CFG.max_daily_count_per_plugin;
  if (usedCount + 1 > countMax) {
    throw fail(`今日对该插件的支付次数已达上限（${countMax} 次）`);
  }

  // ---- 事务 ----
  // [FIX] randomBytes(4) → randomBytes(8)：把碰撞空间从 2^32 提到 2^64，
  //   消除"同毫秒 + 随机值撞车"导致的 UNIQUE constraint 失败（极罕见但真存在）。
  const transactionId = `pt_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const metaStr = metadata ? JSON.stringify(metadata) : null;

  // 扣买家（余额不足时 changePoints 会 throw → 整个事务回滚）
  changePoints(buyerId, -amount, 'plugin_payment', 'plugin', null, `${p.name}·${subj}`);
  // 加卖家
  changePoints(p.owner_id, +amount, 'plugin_income', 'plugin', null, `${p.name}·${subj}`);

  const info = db.prepare(
    `INSERT INTO plugin_payments
       (plugin_id, buyer_id, seller_id, amount, subject, order_id, status,
        transaction_id, metadata, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`
  ).run(
    pluginId, buyerId, p.owner_id, amount, subj, oid,
    transactionId, metaStr, now, now
  );

  const row = db.prepare('SELECT * FROM plugin_payments WHERE id = ?')
    .get(Number(info.lastInsertRowid));

  return {
    ok: true,
    alreadyPaid: false,
    payment: toDto(row),
    balance: getBalance(buyerId).balance
  };
};

const pay = transaction(payImpl);

// ============================================================
// 退款
// ============================================================
const refundImpl = (paymentId, actorId, actorRole, reason) => {
  const row = db.prepare('SELECT * FROM plugin_payments WHERE id = ?').get(Number(paymentId));
  if (!row) throw notFound('支付记录不存在');
  if (row.status !== 'paid') throw fail('该记录状态不可退款');

  // 权限：买家（窗口期内）或管理员（不受限）
  const isBuyer = row.buyer_id === actorId;
  const isAdminUser = actorRole === 'developer'
    || actorRole === 'super_admin'
    || actorRole === 'admin';
  if (!isBuyer && !isAdminUser) throw forbidden('无权退款该记录');

  // 买家只能在窗口期内自助退款
  if (isBuyer && !isAdminUser) {
    const age = Date.now() - (row.paid_at || row.created_at);
    if (age > PAY_CFG.refund_window_ms) {
      throw fail('已超过自助退款时限，请联系管理员');
    }
  }

  // 反向两笔记账。卖家余额不足时 changePoints 会 throw → 整体回滚。
  // 这是**有意的**：不允许卖家账户变成负数（管理员先追回卖家的积分才能退）。
  changePoints(row.seller_id, -row.amount, 'plugin_refund_out', 'plugin', null,
    `退款：${row.subject}`);
  changePoints(row.buyer_id, +row.amount, 'plugin_refund_in', 'plugin', null,
    `退款：${row.subject}`);

  const now = Date.now();
  db.prepare(
    `UPDATE plugin_payments
        SET status = 'refunded', refunded_at = ?, refunded_by = ?, refund_reason = ?
      WHERE id = ?`
  ).run(now, actorId, String(reason || '').slice(0, 200), row.id);

  audit(
    actorId, actorRole, 'plugin_refund', 'plugin_payment', row.id,
    `plugin=${row.plugin_id} amount=${row.amount} reason=${reason || '—'}`
  );

  const updated = db.prepare('SELECT * FROM plugin_payments WHERE id = ?').get(row.id);
  return {
    ok: true,
    payment: toDto(updated),
    balance: getBalance(row.buyer_id).balance
  };
};

const refund = transaction(refundImpl);

// ============================================================
// 查询
// ============================================================
function getById(paymentId) {
  return toDto(db.prepare('SELECT * FROM plugin_payments WHERE id = ?').get(Number(paymentId)));
}

function listByBuyer(buyerId, limit = 100) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = db.prepare(
    `SELECT pp.*, p.name AS pluginName, p.icon_url AS pluginIcon,
            u.nickname AS sellerName
       FROM plugin_payments pp
       LEFT JOIN plugins p ON p.id = pp.plugin_id
       LEFT JOIN users u ON u.id = pp.seller_id
      WHERE pp.buyer_id = ?
      ORDER BY pp.created_at DESC LIMIT ?`
  ).all(buyerId, lim);
  return rows.map((r) => ({
    ...toDto(r),
    pluginName: r.pluginName || r.plugin_id,
    pluginIcon: r.pluginIcon || null,
    sellerName: r.sellerName || `#${r.seller_id}`
  }));
}

function listBySeller(sellerId, limit = 100) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = db.prepare(
    `SELECT pp.*, p.name AS pluginName, p.icon_url AS pluginIcon,
            u.nickname AS buyerName
       FROM plugin_payments pp
       LEFT JOIN plugins p ON p.id = pp.plugin_id
       LEFT JOIN users u ON u.id = pp.buyer_id
      WHERE pp.seller_id = ?
      ORDER BY pp.created_at DESC LIMIT ?`
  ).all(sellerId, lim);
  return rows.map((r) => ({
    ...toDto(r),
    pluginName: r.pluginName || r.plugin_id,
    pluginIcon: r.pluginIcon || null,
    buyerName: r.buyerName || `#${r.buyer_id}`
  }));
}

function listAll({ limit = 200, pluginId = null, status = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const where = [];
  const args = [];
  if (pluginId) { where.push('pp.plugin_id = ?'); args.push(String(pluginId)); }
  if (status)   { where.push('pp.status = ?');    args.push(String(status)); }
  const sql = `
    SELECT pp.*, p.name AS pluginName, p.icon_url AS pluginIcon,
           bu.nickname AS buyerName, su.nickname AS sellerName
      FROM plugin_payments pp
      LEFT JOIN plugins p  ON p.id  = pp.plugin_id
      LEFT JOIN users bu   ON bu.id = pp.buyer_id
      LEFT JOIN users su   ON su.id = pp.seller_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY pp.created_at DESC LIMIT ?`;
  args.push(lim);
  const rows = db.prepare(sql).all(...args);
  return rows.map((r) => ({
    ...toDto(r),
    pluginName: r.pluginName || r.plugin_id,
    pluginIcon: r.pluginIcon || null,
    buyerName: r.buyerName || `#${r.buyer_id}`,
    sellerName: r.sellerName || `#${r.seller_id}`
  }));
}

// ============================================================
// 统计（给作者/管理员看）
// ============================================================
function statsForPlugin(pluginId) {
  const row = db.prepare(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'paid')      AS paidCount,
       COUNT(*) FILTER (WHERE status = 'refunded')  AS refundCount,
       COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)     AS paidSum,
       COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0) AS refundSum
     FROM plugin_payments WHERE plugin_id = ?`
  ).get(String(pluginId));
  return {
    paidCount: row.paidCount || 0,
    refundCount: row.refundCount || 0,
    paidSum: row.paidSum || 0,
    refundSum: row.refundSum || 0
  };
}

module.exports = {
  // 前置
  checkRateLimit, payInfo,

  // 主流程
  pay, refund,

  // 查询
  getById, listByBuyer, listBySeller, listAll,

  // 统计
  statsForPlugin,

  // 常量（供路由与测试断言）
  ORDER_ID_RE,
  SUBJECT_MAX
};