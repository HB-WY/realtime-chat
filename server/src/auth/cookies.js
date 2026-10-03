// server/src/auth/cookies.js
//
// 轻量 Cookie 读写（不引入 cookie-parser 依赖：项目风格是零依赖优先，
// 而这里用到的功能就这两件：解析请求头的 Cookie、往响应写 Set-Cookie）。
//
// [SEC] 三处安全属性必须正确：
//   · HttpOnly —— JS 拿不到（XSS 偷不走 Refresh Token）
//   · Secure   —— 只在 HTTPS 上发送（生产必须；开发用 http://127.0.0.1 时不能设）
//   · SameSite —— 统一用 Strict（刷新端点只被同站请求调用）
//
const config = require('../config');

const REFRESH_COOKIE = config.AUTH_CFG.refresh_cookie_name || 'rt';
const REFRESH_PATH = config.AUTH_CFG.refresh_cookie_path || '/api/auth';

// ============================================================
// 解析
// ============================================================
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    // Cookie 值里的非 ASCII 会被 URL 编码；这里解码并容忍失败
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function getCookie(req, name) {
  if (req?.cookies && typeof req.cookies === 'object') return req.cookies[name];
  return parseCookies(req?.headers?.cookie || '')[name];
}

// ============================================================
// 写
// ============================================================
function serializeCookie(name, value, {
  maxAge, path = '/', httpOnly = true, secure = false, sameSite = 'Strict'
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${path}`);
  if (maxAge !== undefined && maxAge !== null) {
    parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookieStr) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookieStr);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookieStr]);
  else res.setHeader('Set-Cookie', [prev, cookieStr]);
}

/** 是否需要 Secure 属性：生产环境或有反代时 */
function shouldUseSecure(req) {
  if (config.IS_PROD) return true;
  // 反代传了 X-Forwarded-Proto: https 时也算（此时 config.TRUST_PROXY 通常为 true）
  if (config.TRUST_PROXY && req?.headers?.['x-forwarded-proto'] === 'https') return true;
  return false;
}

/**
 * 写 Refresh Cookie。HttpOnly + SameSite=Strict + 限定 Path。
 * 明文 token 只在这一次 Set-Cookie 里出现，之后端侧也拿不到（只存 hash）。
 */
function setRefreshCookie(req, res, plain, ttlMs) {
  appendSetCookie(res, serializeCookie(REFRESH_COOKIE, plain, {
    maxAge: ttlMs,
    path: REFRESH_PATH,
    httpOnly: true,
    secure: shouldUseSecure(req),
    sameSite: 'Strict'
  }));
}

/** 清除 Refresh Cookie（登出 / 检测到重放） */
function clearRefreshCookie(req, res) {
  appendSetCookie(res, serializeCookie(REFRESH_COOKIE, '', {
    maxAge: 0,
    path: REFRESH_PATH,
    httpOnly: true,
    secure: shouldUseSecure(req),
    sameSite: 'Strict'
  }));
}

module.exports = {
  REFRESH_COOKIE,
  REFRESH_PATH,
  parseCookies,
  getCookie,
  serializeCookie,
  setRefreshCookie,
  clearRefreshCookie,
  shouldUseSecure
};