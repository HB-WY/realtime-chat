// src/auth/apikey.js
//
// API 密钥：独立于 JWT 的第二认证通道。
//
//   - 明文只在申请时返回一次；库里只存 sha256 哈希 + 12 位前缀
//   - 每把密钥绑定申请时的来源 IP，此后每次使用都强制比对，不匹配即 403
//   - 同一 IP 只能绑定一个用户；撤销密钥不释放 IP 绑定；管理员可手动释放
//   - 账号被封禁 / 禁用 → 密钥即时失效（每次请求都重新载入用户状态）
//   - 独立按密钥限流，不复用 JWT 通道规则
//
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const { clientIp } = require('../utils/ip');
const { audit } = require('../services/permissions');

const CFG = config.APIKEY_CFG;
const RATE = config.APIKEY_RATE || { window_ms: 60000, max: 600 };

const PREFIX_LEN = CFG.prefix_len || 12;
const SECRET_LEN = CFG.secret_len || 40;
const KEY_PREFIX = 'rk_';
const KEY_BODY_LEN = PREFIX_LEN + SECRET_LEN;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// ============================================================
// 生成 / 哈希
// ============================================================
function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function hashKey(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 生成一枚新密钥：返回 { plain, prefix, hash }（plain 只出现这一次） */
function generateKey() {
  const body = randomString(KEY_BODY_LEN);
  const prefix = body.slice(0, PREFIX_LEN);
  const plain = `${KEY_PREFIX}${body}`;
  return { plain, prefix, hash: hashKey(plain) };
}

function parseKey(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith(KEY_PREFIX)) return null;
  const body = s.slice(KEY_PREFIX.length);
  if (body.length !== KEY_BODY_LEN) return null;
  if (!/^[A-Za-z0-9]+$/.test(body)) return null;
  return { prefix: body.slice(0, PREFIX_LEN), plain: s };
}

function maskKey(prefix) {
  return `${KEY_PREFIX}${prefix}${'*'.repeat(8)}`;
}

// ============================================================
// IP 绑定
// ============================================================
function ipClaimOf(ip) {
  return db.prepare('SELECT * FROM apikey_ip_claims WHERE ip = ?').get(ip) || null;
}

/** 占用 IP（已释放 / 不存在 → 可占用；同一用户 → 续期；他人 → 拒绝） */
function claimIp(ip, userId, note = null) {
  if (CFG.ip_binding === false) return { ok: true, claimed: false };
  const now = Date.now();
  const row = ipClaimOf(ip);

  if (!row) {
    db.prepare(
      `INSERT INTO apikey_ip_claims (ip, user_id, created_at, updated_at, released_at, released_by, note)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`
    ).run(ip, userId, now, now, note);
    return { ok: true, claimed: true };
  }

  if (row.released_at) {
    db.prepare(
      `UPDATE apikey_ip_claims
       SET user_id = ?, updated_at = ?, released_at = NULL, released_by = NULL, note = ?
       WHERE ip = ?`
    ).run(userId, now, note, ip);
    return { ok: true, claimed: true, reclaimed: true };
  }

  if (row.user_id === userId) {
    db.prepare('UPDATE apikey_ip_claims SET updated_at = ? WHERE ip = ?').run(now, ip);
    return { ok: true, claimed: false };
  }

  return { ok: false, error: '该 IP 已绑定其他账号', ownerId: row.user_id };
}

/** 管理员手动释放 */
function releaseIp(ip, actorId, note = null) {
  const row = ipClaimOf(ip);
  if (!row) return { ok: false, error: '该 IP 没有被绑定' };
  if (row.released_at) return { ok: false, error: '该 IP 绑定已释放' };
  db.prepare(
    'UPDATE apikey_ip_claims SET released_at = ?, released_by = ?, note = ? WHERE ip = ?'
  ).run(Date.now(), actorId, note, ip);
  return { ok: true };
}

function listIpClaims({ onlyActive = false, limit = 200 } = {}) {
  const sql = onlyActive
    ? `SELECT c.ip, c.user_id AS userId, c.created_at AS createdAt, c.updated_at AS updatedAt,
              c.released_at AS releasedAt, c.released_by AS releasedBy, c.note,
              u.username, u.nickname, u.avatar,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = c.user_id) AS keyCount
       FROM apikey_ip_claims c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.released_at IS NULL
       ORDER BY c.updated_at DESC LIMIT ?`
    : `SELECT c.ip, c.user_id AS userId, c.created_at AS createdAt, c.updated_at AS updatedAt,
              c.released_at AS releasedAt, c.released_by AS releasedBy, c.note,
              u.username, u.nickname, u.avatar,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = c.user_id) AS keyCount
       FROM apikey_ip_claims c LEFT JOIN users u ON u.id = c.user_id
       ORDER BY c.updated_at DESC LIMIT ?`;
  return db.prepare(sql).all(Math.min(Number(limit) || 200, 500));
}

// ============================================================
// 限流（按密钥 / 按 IP 失败次数）
//
// [SEC] 这两张表是按「密钥 id」「IP」增长的进程内 Map。如果不做清理，
//       长期运行 + 大量不同 IP / 密钥会把内存撑爆（也是一种 DoS 面）。
//       这里定期清掉窗口外的空条目，并用 unref 的定时器兜底。
// ============================================================
const FAIL_WINDOW_MS = 60000;
const FAIL_MAX = 30;

const keyHits = new Map();
const ipFailures = new Map();

let opCount = 0;
const PRUNE_EVERY = 500;

/** 清掉窗口内已无记录的 key / ip，防止 Map 无限增长 */
function prune() {
  const now = Date.now();
  for (const [k, arr] of keyHits) {
    const kept = arr.filter((t) => now - t < RATE.window_ms);
    if (kept.length === 0) keyHits.delete(k);
    else if (kept.length !== arr.length) keyHits.set(k, kept);
  }
  for (const [ip, arr] of ipFailures) {
    const kept = arr.filter((t) => now - t < FAIL_WINDOW_MS);
    if (kept.length === 0) ipFailures.delete(ip);
    else if (kept.length !== arr.length) ipFailures.set(ip, kept);
  }
}

// 每隔一段时间强制清理一次；unref 保证不阻塞进程退出
const pruneTimer = setInterval(prune, 5 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

function tick() {
  if (++opCount >= PRUNE_EVERY) {
    opCount = 0;
    prune();
  }
}

function allowKey(keyId) {
  const now = Date.now();
  const arr = (keyHits.get(keyId) || []).filter((t) => now - t < RATE.window_ms);
  if (arr.length >= RATE.max) {
    keyHits.set(keyId, arr);
    return { ok: false, retryAfter: Math.ceil((RATE.window_ms - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  keyHits.set(keyId, arr);
  tick();
  return { ok: true };
}

function failIp(ip) {
  const now = Date.now();
  const arr = (ipFailures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  arr.push(now);
  ipFailures.set(ip, arr);
  tick();
  return arr.length;
}

function ipBlocked(ip) {
  const now = Date.now();
  const arr = (ipFailures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (arr.length === 0) ipFailures.delete(ip);
  else ipFailures.set(ip, arr);
  return arr.length >= FAIL_MAX;
}

function resetIp(ip) {
  ipFailures.delete(ip);
}

// ============================================================
// 密钥级 IP 绑定（强制生效）
//
// [SEC] 历史缺陷：申请时把来源 IP 写进响应里的 boundIp 就完事了，使用时
//       一次都不比对 —— 等于「IP 绑定」只在 UI 上好看。密钥一旦泄露
//       （日志 / 截图 / 代码仓库 / 中间人），攻击者可从任意 IP 直接使用。
//       这里补齐真正的那一步：每次认证都要求来源 IP 与 bound_ip 完全一致。
//
//       两个前提必须同时成立才有意义：
//         1) 来源 IP 取自信任渠道 —— utils/ip.js 默认只认 TCP 对端，
//            只有 security.trust_proxy=true 时才采信反代写入的 XFF；
//         2) 后端本身不能对局域网直接开放 —— 否则任何人可直连 3001，
//            让「绑 127.0.0.1」这类绑定形同虚设（见 config.yaml → server.host）。
// ============================================================
function enforceIpBinding(boundIp, ip, keyId, userRow) {
  if (CFG.ip_binding === false) return { ok: true };

  // [SEC] 老库遗留密钥（bound_ip 为 NULL）不再「首次使用就地绑定」：
  //       窃取者可能抢先把密钥绑到自己 IP，把合法用户反锁在外。
  //       缺少绑定的密钥一律拒绝，需要用户重新申请（或管理员处理）。
  if (!boundIp) {
    return {
      ok: false,
      code: 403,
      error: '该 API 密钥缺少 IP 绑定（历史遗留数据），请撤销后重新申请'
    };
  }

  if (boundIp === ip) return { ok: true };

  try {
    audit(
      userRow.id, userRow.role, 'apikey_ip_mismatch', 'apikey', keyId,
      `绑定 ${boundIp}，来源 ${ip}`
    );
  } catch (err) {
    console.error('[apikey ip mismatch audit]', err);
  }
  return {
    ok: false,
    code: 403,
    error: `该 API 密钥已绑定来源 IP ${boundIp}，当前来源为 ${ip}，拒绝使用`
  };
}

// ============================================================
// 认证
// ============================================================
/**
 * @returns {{ok:true,user:object,key:object,ip:string}} 或
 *          {{ok:false,code:number,error:string}}
 */
function authenticateApiKey(raw, req) {
  const ip = clientIp(req);

  if (ipBlocked(ip)) {
    return { ok: false, code: 429, error: '失败次数过多，请稍后再试' };
  }

  const parsed = parseKey(raw);
  if (!parsed) {
    failIp(ip);
    return { ok: false, code: 401, error: 'API 密钥格式不正确' };
  }

  const candidates = db.prepare('SELECT * FROM api_keys WHERE prefix = ?').all(parsed.prefix);
  const hash = hashKey(parsed.plain);
  const row = candidates.find((c) => safeEqual(c.key_hash, hash));

  if (!row) {
    failIp(ip);
    return { ok: false, code: 401, error: 'API 密钥无效' };
  }
  if (row.revoked_at) {
    failIp(ip);
    return { ok: false, code: 401, error: 'API 密钥已撤销' };
  }

  // 账号被封禁 / 禁用 → 即时失效
  const userRow = db.prepare(
    'SELECT id, username, nickname, avatar, role, status FROM users WHERE id = ?'
  ).get(row.user_id);
  if (!userRow || userRow.status !== 'active') {
    failIp(ip);
    return { ok: false, code: 401, error: '用户不存在或已被禁用' };
  }

  // [SEC] 密钥级 IP 绑定：不匹配直接拒绝（先于 IP 占用检查，报错更具体）
  const bind = enforceIpBinding(row.bound_ip, ip, row.id, userRow);
  if (!bind.ok) {
    return { ok: false, code: bind.code, error: bind.error };
  }

  // 同一 IP 只能绑定一个用户
  const claim = claimIp(ip, userRow.id, '首次使用自动绑定');
  if (!claim.ok) {
    return { ok: false, code: 403, error: claim.error };
  }

  const rate = allowKey(row.id);
  if (!rate.ok) {
    return { ok: false, code: 429, error: `密钥调用过于频繁，请 ${rate.retryAfter} 秒后重试` };
  }

  resetIp(ip);

  // 最近使用时间：30 秒节流写库
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 30000) {
    db.prepare('UPDATE api_keys SET last_used_at = ?, last_ip = ? WHERE id = ?')
      .run(now, ip, row.id);
  }

  return {
    ok: true,
    ip,
    key: { id: row.id, prefix: row.prefix, userId: row.user_id },
    user: {
      id: userRow.id,
      username: userRow.username,
      nickname: userRow.nickname,
      avatar: userRow.avatar || '',
      role: userRow.role || 'user'
    }
  };
}

module.exports = {
  PREFIX_LEN, SECRET_LEN, KEY_PREFIX,
  generateKey, hashKey, parseKey, maskKey,
  ipClaimOf, claimIp, releaseIp, listIpClaims,
  authenticateApiKey, allowKey, enforceIpBinding,
  pruneRateLimitState: prune,
  hashPrefix: (k) => k.slice(0, PREFIX_LEN)
};
