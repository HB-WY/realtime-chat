// server/src/auth/tokens.js
//
// 双 token 体系：短期 Access Token（JWT，前端内存持有）+ 长期 Refresh Token
// （随机串，HttpOnly Cookie 持有，可撤销、可轮换）。
//
// 为什么不都用 JWT：Refresh Token 需要**可撤销**（登出、密码修改、检测到
// 重放时整族作废）。JWT 无状态、签发后无法撤销，所以 Refresh 用随机串 + 落库。
//
// Access Token 保持 JWT：无状态、无需查库，每次请求只验签。
//
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

const JWT_SECRET = config.JWT_SECRET;
const ACCESS_TTL = config.AUTH_CFG.access_ttl;         // '15m' 等
const REFRESH_TTL_MS = config.AUTH_CFG.refresh_ttl_ms; // 毫秒

// ============================================================
// Access Token
// ============================================================
function signAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar || '',
      role: user.role || 'user',
      // 标注 token 类型：防止把 Refresh 当 Access 用，也防止反之
      typ: 'access'
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  // 只接受 access 类型。历史上签发的旧 JWT 没有 typ 字段，
  // 视为 access（迁移期兼容，30 天后旧 token 全部过期自然失效）。
  if (payload.typ && payload.typ !== 'access') {
    throw new Error('token 类型不匹配');
  }
  return payload;
}

// ============================================================
// Refresh Token
//
// 明文形如 `rt_<64 hex>`；库里只存 SHA-256 哈希。生成时用 CSPRNG。
// ============================================================
const REFRESH_PREFIX = 'rt_';
const REFRESH_BYTES = 32; // 256 bit

function generateRefreshToken() {
  const body = crypto.randomBytes(REFRESH_BYTES).toString('hex');
  const plain = `${REFRESH_PREFIX}${body}`;
  return { plain, hash: hashRefreshToken(plain) };
}

function hashRefreshToken(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

/** 从原始 Cookie 值里判断它是不是 Refresh Token（用于快速排除垃圾值） */
function looksLikeRefreshToken(v) {
  return typeof v === 'string'
    && v.startsWith(REFRESH_PREFIX)
    && v.length === REFRESH_PREFIX.length + REFRESH_BYTES * 2;
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
  ACCESS_TTL,
  REFRESH_TTL_MS
};