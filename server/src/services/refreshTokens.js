// server/src/services/refreshTokens.js
//
// Refresh Token 的落库管理：签发、校验、轮换、撤销、重放检测。
//
// 表结构（见 schema.js）：
//   refresh_tokens(
//     id, user_id, token_hash UNIQUE, family_id,
//     user_agent, ip,
//     created_at, expires_at, revoked_at, replaced_by
//   )
//
// 轮换语义：
//   · 每次刷新都签发新 token，旧的立即置 revoked_at 并记录 replaced_by
//   · 收到一个「已 revoked」的 token → 说明它可能被盗用 → **撤销整个 family**
//     （同 family 的所有 token 全部作废，用户被强制重新登录）
//
const crypto = require('crypto');
const { db } = require('../db');
const { transaction } = require('../db/tx');
const { generateRefreshToken, hashRefreshToken, REFRESH_TTL_MS } = require('../auth/tokens');

// ============================================================
// 签发
// ============================================================
const issueImpl = (userId, { userAgent = '', ip = '', familyId = null } = {}) => {
  const { plain, hash } = generateRefreshToken();
  const now = Date.now();
  const fam = familyId || crypto.randomUUID();

  db.prepare(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, family_id, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, hash, fam, String(userAgent).slice(0, 300), String(ip).slice(0, 64),
    now, now + REFRESH_TTL_MS);

  return { plain, familyId: fam, expiresAt: now + REFRESH_TTL_MS };
};

const issue = transaction(issueImpl);

// ============================================================
// 校验 + 轮换
// ============================================================
/**
 * @returns {{ok:true, userId:number, newPlain:string, newFamilyId:string}
 *          | {ok:false, reason:'not_found'|'expired'|'revoked'|'replayed'}}
 */
const rotateImpl = (plain, { userAgent = '', ip = '' } = {}) => {
  if (typeof plain !== 'string' || !plain) return { ok: false, reason: 'not_found' };

  const hash = hashRefreshToken(plain);
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash);
  if (!row) return { ok: false, reason: 'not_found' };

  const now = Date.now();

  // 已撤销 → 可能是被盗用（攻击者拿着旧 token 来换），撤销整个 family
  if (row.revoked_at) {
    db.prepare(
      `UPDATE refresh_tokens
          SET revoked_at = ?
        WHERE family_id = ? AND revoked_at IS NULL`
    ).run(now, row.family_id);
    return { ok: false, reason: 'replayed' };
  }

  if (row.expires_at <= now) {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(now, row.id);
    return { ok: false, reason: 'expired' };
  }

  // 正常轮换：作废旧 token + 签发新 token（同 family）
  const { plain: newPlain, hash: newHash } = generateRefreshToken();
  const newExpiresAt = now + REFRESH_TTL_MS;

  const info = db.prepare(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, family_id, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.user_id, newHash, row.family_id,
    String(userAgent).slice(0, 300), String(ip).slice(0, 64), now, newExpiresAt);

  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?'
  ).run(now, Number(info.lastInsertRowid), row.id);

  return { ok: true, userId: row.user_id, newPlain, newFamilyId: row.family_id };
};

const rotate = transaction(rotateImpl);

// ============================================================
// 撤销
// ============================================================
function revokeByToken(plain) {
  if (!plain) return;
  const hash = hashRefreshToken(plain);
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(Date.now(), hash);
}

function revokeAllForUser(userId) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId);
}

/** 用户改密码 / 被禁用 / 被查封时调用 */
function revokeFamily(familyId) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
    .run(Date.now(), familyId);
}

// ============================================================
// 清理（定期调用，见 index.js）
// ============================================================
function pruneExpired() {
  // 过期 30 天以上的行整行删；保留近期记录便于审计
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const info = db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(cutoff);
  return info.changes;
}

module.exports = {
  issue,
  rotate,
  revokeByToken,
  revokeAllForUser,
  revokeFamily,
  pruneExpired
};