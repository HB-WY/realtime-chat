// client/src/auth/session.js
//
// 会话管理（双 token 体系的前端核心）。
//
// [SEC] Access Token 只活在**模块内存**里，不落 localStorage、不落 sessionStorage、
//       不放 Cookie —— 这样 XSS 拿不到长期凭据（Refresh 在 HttpOnly Cookie 里，
//       JS 也拿不到）。代价：页面刷新后内存清空，要用 Refresh 换一次。
//
// 前端其他地方不要直接读模块变量，用 `subscribe` 订阅变化，或用 `getAccessToken()`。
//
import { API_BASE } from '../api/http';

// ---------- 内存态（唯一真相） ----------
let accessToken = null;
let user = null;

// ---------- 订阅者（App.jsx 用来感知登录/登出） ----------
const listeners = new Set();
function emit() {
  for (const cb of listeners) {
    try { cb(getSnapshot()); } catch { /* 订阅者自己的错不该拖垮这里 */ }
  }
}
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getSnapshot() {
  return { accessToken, user };
}

// ---------- 内部：低层 fetch ----------
async function rawFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    // [SEC] 必须带上 Cookie（Refresh 才能随刷新请求一起发过去）
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { res, data };
}

// ---------- 刷新中的并发去重 ----------
// 多个请求同时 401 时，只发一次 refresh；其他等它完成后重放。
let refreshing = null;
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { res, data } = await rawFetch('/auth/refresh', {
        method: 'POST',
        body: '{}'
      });
      if (!res.ok) throw new Error(data?.error || '刷新失败');
      accessToken = data.accessToken;
      user = data.user;
      emit();
      return data;
    } catch (err) {
      accessToken = null;
      user = null;
      emit();
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- 登录 / 注册 ----------
export async function login(username, password) {
  const { res, data } = await rawFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(data?.error || '登录失败');
  accessToken = data.accessToken || data.token;
  user = data.user;
  emit();
  return data;
}

export async function register(username, password, nickname, avatar) {
  const { res, data } = await rawFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, nickname, avatar })
  });
  if (!res.ok) throw new Error(data?.error || '注册失败');
  accessToken = data.accessToken || data.token;
  user = data.user;
  emit();
  return data;
}

// ---------- 登出 ----------
export async function logout() {
  try {
    await rawFetch('/auth/logout', { method: 'POST', body: '{}' });
  } catch { /* 网络失败也照样本地清 */ }
  accessToken = null;
  user = null;
  emit();
}

// ---------- 更新 user（改昵称 / 头像后用） ----------
export function setUser(next) {
  if (!next) return;
  user = { ...(user || {}), ...next };
  emit();
}

// ---------- 给 http.js 用 ----------
export function getAccessToken() {
  return accessToken;
}
export function isAuthed() {
  return !!accessToken && !!user;
}