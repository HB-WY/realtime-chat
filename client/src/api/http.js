// client/src/api/http.js
//
// 基础 HTTP 封装（Cookie + 刷新令牌版）。
//
// 核心流程：
//   1) 每次请求带 `credentials: 'include'`（Refresh Cookie 才能被带上）
//   2) 带 Authorization: Bearer <accessToken>（从内存读，见 auth/session.js）
//   3) 401 TOKEN_EXPIRED → 自动调 refresh() 换新 access → **重放原请求**（只重放一次）
//   4) 刷新失败 → 派发 auth:expired 事件，App.jsx 监听后清状态回登录页
//
// [SEC] 不再从 localStorage 读 token；任何持久化凭据都不经过 JS 可见的地方。
//
import * as session from '../auth/session';

const API_BASE = '/api';

/** 派发"认证失效"事件；App.jsx 里监听 */
function emitAuthExpired() {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
  } catch {
    /* SSR / 测试环境下忽略 */
  }
}

/**
 * 统一请求。
 * @param {string} path         例如 '/auth/login'（会拼成 /api/auth/login）
 * @param {object} [opts]
 * @param {string} [opts.method] 默认 GET
 * @param {object} [opts.body]   JSON body
 * @param {boolean} [opts.isForm] 传 true 时 body 应为 FormData
 * @param {boolean} [opts._retried] 内部用：标记这次是重放，防止无限循环
 *
 * [NOTE] 兼容旧签名：以前第二个参数里有 `token`，现在**忽略**它。
 */
export async function request(path, opts = {}) {
  const { method = 'GET', body, isForm, _retried = false } = opts;

  const headers = {};
  const access = session.getAccessToken();
  if (access) headers.Authorization = `Bearer ${access}`;

  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: payload,
      // [SEC] Cookie 随请求发送（Refresh 在 /api/auth/refresh 时被读到）
      credentials: 'include'
    });
  } catch (err) {
    // 网络层错误：包装成带 status=0 的 Error
    const e = new Error('网络异常，请检查连接');
    e.status = 0;
    e.data = null;
    e.cause = err;
    throw e;
  }

  // ---------- 401 自动刷新 + 重放（仅一次） ----------
  if (res.status === 401 && !_retried && !isAuthEndpoint(path)) {
    let data = null;
    try { data = await res.clone().json(); } catch { /* ignore */ }
    const code = data?.code;

    // 只有"access 过期"值得刷新；其他 401（未登录/refresh 无效）直接抛出
    const worthRetry = code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID' || !code;
    if (worthRetry) {
      try {
        await session.refresh();
        // 用同样的参数重放一次（_retried 标记防止再次触发刷新）
        return request(path, { ...opts, _retried: true });
      } catch {
        // 刷新也失败 → 认证彻底失效
        emitAuthExpired();
        const e = new Error(data?.error || '登录已过期');
        e.status = 401;
        e.data = data;
        throw e;
      }
    }
  }

  // ---------- 正常响应 ----------
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 空响应体或非 JSON */
  }

  if (!res.ok) {
    // 其他路径的 401（比如登录接口本身密码错误）不派发"认证失效"
    if (res.status === 401 && !isAuthEndpoint(path)) emitAuthExpired();
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 这些端点的 401 属于业务错误（密码错 / refresh 无效），不该触发"清 auth 回登录页" */
function isAuthEndpoint(path) {
  return path.startsWith('/auth/') && !path.startsWith('/auth/me');
}

export { API_BASE, emitAuthExpired };