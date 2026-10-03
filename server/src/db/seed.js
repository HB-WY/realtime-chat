// src/db/seed.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

module.exports = function seed(db) {
  const OFFICIAL = config.OFFICIAL_ACCOUNT;
  const SIGNUP_POINTS = config.BUSINESS.signup_points;

  // ============================================================
  // 1) 官方系统账户
  //
  // [SEC] 该账户角色是 developer，必须绝对无法登录：
  //       用 bcrypt 真正哈希一串 32 字节随机密码（随机值不落库、不输出），
  //       任何猜测都不可能匹配。不要手搓 `$2a$10$` + 随机 base64 —— 
  //       格式一旦不合规，bcrypt 的解析行为依赖实现细节，风险不可控。
  // ============================================================
  let officialRow = db.prepare('SELECT id FROM users WHERE username = ?').get(OFFICIAL.username);
  if (!officialRow) {
    const lockHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, nickname, avatar, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).run(
      OFFICIAL.username,
      lockHash,
      OFFICIAL.nickname,
      OFFICIAL.avatar,
      OFFICIAL.role,
      Date.now()
    );
    officialRow = { id: Number(info.lastInsertRowid) };
    console.log(`[db] 已创建官方系统账户 id=${officialRow.id}`);
  }
  const OFFICIAL_USER_ID = officialRow.id;

  // [FIX] 官方账户显式 0 余额开户：避免首次托管时 ensureAccount 兜底
  //       建户发放注册积分（见 points.js 的同款修复）。
  const officialPoints = db.prepare(
    'SELECT user_id FROM user_points WHERE user_id = ?'
  ).get(OFFICIAL_USER_ID);
  if (!officialPoints) {
    db.prepare(
      'INSERT INTO user_points (user_id, balance, frozen, updated_at) VALUES (?, 0, 0, ?)'
    ).run(OFFICIAL_USER_ID, Date.now());
  }

  // ============================================================
  // 2) 老用户补初始积分
  //    [FIX] 两条 SQL 包进事务：中途崩溃不再出现「有余额无流水」
  // ============================================================
  const usersWithoutPoints = db.prepare(
    'SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM user_points)'
  ).all();
  const now = Date.now();
  const insertPoints = db.prepare(
    'INSERT INTO user_points (user_id, balance, frozen, updated_at) VALUES (?, ?, 0, ?)'
  );
  const insertTx = db.prepare(
    `INSERT INTO points_transactions (user_id, delta, balance_after, reason, created_at)
     VALUES (?, ?, ?, 'signup', ?)`
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of usersWithoutPoints) {
      insertPoints.run(u.id, SIGNUP_POINTS, now);
      insertTx.run(u.id, SIGNUP_POINTS, SIGNUP_POINTS, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // ============================================================
  // 3) 环境变量指定开发者
  // ============================================================
  if (process.env.DEVELOPER_USERNAME) {
    const dev = db.prepare('SELECT id FROM users WHERE username = ?')
      .get(process.env.DEVELOPER_USERNAME);
    if (dev) {
      db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(dev.id);
      console.log(`[db] 已指定 ${process.env.DEVELOPER_USERNAME} 为开发者`);
    } else {
      console.warn(`[db] 警告：DEVELOPER_USERNAME=${process.env.DEVELOPER_USERNAME} 不存在`);
    }
  }

  return { OFFICIAL_USER_ID, OFFICIAL_USERNAME: OFFICIAL.username };
};