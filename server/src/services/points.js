// src/services/points.js
const { db, OFFICIAL_USER_ID } = require('../db');
const { transaction } = require('../db/tx');
const SIGNUP_POINTS = require('../config').BUSINESS.signup_points;

/**
 * 确保用户在 user_points 有行。没有则按注册初始值创建。
 * 注册接口调用；changePoints 内部也会兜底调用。
 *
 * [FIX] 官方托管账户不发放注册积分：首次托管红包 / 转账触发建户时，
 *       原实现会让 OFFICIAL 账户凭空获得 signup_points 与一条 'signup'
 *       流水，账面噪声且双边记账不平。官方账户一律 0 余额开户。
 */
function ensureAccount(userId) {
  const row = db.prepare('SELECT user_id FROM user_points WHERE user_id = ?').get(userId);
  if (row) return;
  const now = Date.now();
  const initial = Number(userId) === Number(OFFICIAL_USER_ID) ? 0 : SIGNUP_POINTS;
  db.prepare(
    'INSERT INTO user_points (user_id, balance, frozen, updated_at) VALUES (?, ?, 0, ?)'
  ).run(userId, initial, now);
  if (initial > 0) {
    db.prepare(
      `INSERT INTO points_transactions (user_id, delta, balance_after, reason, created_at)
       VALUES (?, ?, ?, 'signup', ?)`
    ).run(userId, initial, initial, now);
  }
}

/**
 * 改动积分，写流水。事务化（支持嵌套 SAVEPOINT）。
 */
const changePoints = transaction((userId, delta, reason, refType = null, refId = null, note = null) => {
  let row = db.prepare('SELECT * FROM user_points WHERE user_id = ?').get(userId);
  if (!row) {
    ensureAccount(userId);
    row = db.prepare('SELECT * FROM user_points WHERE user_id = ?').get(userId);
  }
  const newBalance = row.balance + delta;
  if (newBalance < 0) throw new Error('积分不足');
  db.prepare('UPDATE user_points SET balance = ?, updated_at = ? WHERE user_id = ?')
    .run(newBalance, Date.now(), userId);
  db.prepare(
    `INSERT INTO points_transactions
      (user_id, delta, balance_after, reason, ref_type, ref_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, delta, newBalance, reason, refType, refId, note, Date.now());
  return newBalance;
});

function getBalance(userId) {
  const row = db.prepare('SELECT balance, frozen FROM user_points WHERE user_id = ?').get(userId);
  return row ? { balance: row.balance, frozen: row.frozen } : { balance: 0, frozen: 0 };
}

function getTransactions(userId, limit = 50) {
  return db.prepare(
    `SELECT id, delta, balance_after AS balanceAfter, reason,
            ref_type AS refType, ref_id AS refId, note, created_at AS createdAt
     FROM points_transactions WHERE user_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit);
}

module.exports = { ensureAccount, changePoints, getBalance, getTransactions };