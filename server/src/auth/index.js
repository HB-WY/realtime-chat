// server/src/auth/index.js
//
// 认证通道（三条）：
//   1) Access Token（JWT，短）：Authorization: Bearer <access>
//      —— 浏览器前端使用；Access 存前端内存，不放 Cookie，因此天然免疫 CSRF
//   2) Refresh Token（长）：HttpOnly Cookie（Path=/api/auth）
//      —— 只用于 /api/auth/refresh 换新的 Access（+ 轮换 Refresh 自身）
//   3) API 密钥：X-API-Key / Authorization: ApiKey
//      —— 脚本通道，与浏览器通道分离
//
// [SEC] 迁移期保留旧的无 typ 字段 JWT 作为 Access 接受（30 天后自然清空）。
//
const { db } = require('../db');
const config = require('../config');
const { authenticateApiKey, parseKey } = require('./apikey');
const { verifyAccessToken, signAccessToken } = require('./tokens');

// 兼容旧名（外部文件仍 require signToken / verifyToken）
function signToken(user) {
  return signAccessToken(user);
}

function verifyToken(token) {
  return verifyAccessToken(token);
}

function loadUser(id) {
  const row = db.prepare(
    'SELECT id, username, nickname, avatar, signature, role, status FROM users WHERE id = ?'
  ).get(id);
  if (!row) return null;
  if (row.status !== 'active') return null;
  return {
    id: row.id, username: row.username, nickname: row.nickname,
    avatar: row.avatar || '', signature: row.signature || '', role: row.role || 'user'
  };
}

/** 从请求头里取 API 密钥明文（没有则 null）
 *
 * [SEC] 不支持 ?api_key= URL 参数：密钥会进反代 access log、浏览器
 *       历史、Referer 头（从使用密钥的页面跳到外站时），泄露面太大。
 *       只保留 X-API-Key / Authorization: ApiKey 两种请求头形式。
 */
function extractApiKey(req) {
  const h = req.headers['x-api-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();

  const auth = req.headers.authorization || '';
  const m = auth.match(/^ApiKey\s+(.+)$/i);
  if (m) return m[1].trim();
  return null;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function authMiddleware(req, res, next) {
  const rawKey = extractApiKey(req);

  // ---------- 通道 3：API 密钥（脚本）----------
  if (rawKey) {
    const r = authenticateApiKey(rawKey, req);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    req.user = r.user;
    req.authType = 'apikey';
    req.apiKey = r.key;
    req.clientIp = r.ip;
    return next();
  }

  // ---------- 通道 1：Access Token（浏览器）----------
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: '未登录', code: 'NO_TOKEN' });
  try {
    const payload = verifyAccessToken(token);
    const user = loadUser(payload.id);
    if (!user) return res.status(401).json({ error: '用户不存在或已被禁用', code: 'USER_INACTIVE' });
    req.user = user;
    req.authType = 'jwt';
    next();
  } catch (err) {
    // [NEW] 区分「过期」与「无效」：前端据此决定是否值得尝试刷新
    if (err && err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '登录已过期', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ error: '登录已过期', code: 'TOKEN_INVALID' });
  }
}

/** /api/v1/* 强制密钥通道：JWT 不能走这条路 */
function requireApiKey(req, res, next) {
  if (!extractApiKey(req)) {
    return res.status(401).json({
      error: '该接口需要 API 密钥，请使用 X-API-Key 请求头'
    });
  }
  next();
}

/** 仅密钥通道可用时的显式标记（供路由内部判断） */
function isApiKeyRequest(req) {
  return req.authType === 'apikey';
}

/**
 * Socket 握手认证。
 *
 * [SEC] Socket 也用 Access Token（不带 Cookie）—— 因为我们的 Access 就不在
 *       Cookie 里。前端在 handshake 的 `auth.token` 里放 Access Token。
 *       Access 过期后 socket 已建立的连接不受影响；重连时前端要先刷新。
 */
function socketAuth(socket, next) {
  const raw = socket.handshake.auth?.token || socket.handshake.auth?.apiKey || '';
  if (!raw) return next(new Error('未登录'));

  // API 密钥（脚本）
  if (parseKey(raw)) {
    const fakeReq = {
      headers: socket.handshake.headers || {},
      socket: { remoteAddress: socket.handshake.address }
    };
    const r = authenticateApiKey(raw, fakeReq);
    if (!r.ok) return next(new Error(r.error));
    socket.user = r.user;
    socket.authType = 'apikey';
    return next();
  }

  // Access Token（浏览器）
  try {
    const payload = verifyAccessToken(raw);
    const user = loadUser(payload.id);
    if (!user) return next(new Error('用户不存在或已被禁用'));
    socket.user = user;
    socket.authType = 'jwt';
    next();
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') return next(new Error('登录已过期'));
    next(new Error('登录已过期'));
  }
}

module.exports = {
  signToken, verifyToken, authMiddleware, socketAuth, loadUser,
  extractApiKey, requireApiKey, isApiKeyRequest
};