// client/src/utils/authStorage.js
//
// [SEC] 认证改造后这里只负责"会话不在时给 App 一个兜底 UI 状态"。
//   Access Token 不再落 localStorage（在 auth/session.js 的内存里），
//   Refresh Token 在 HttpOnly Cookie（JS 完全看不到）。
//
//   保留 user 的本地缓存是为了：**首屏不必等 /auth/refresh 就能渲染出用户名头像**，
//   刷新成功后会用服务端返回的 user 覆盖它。缓存被篡改也无所谓 —— 它只影响
//   本地首屏，服务端每次请求都会重新加载真实用户。
//
const USER_KEY = 'chat_user_cache';

export function saveAuth(_token, user) {
  // token 参数保留（兼容调用方），实际不再落盘
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* 隐私模式 / 配额满：忽略 */ }
}

export function loadAuth() {
  // 返回 { user }，但 token 为 null —— 由 App.jsx 启动时用 refresh() 补上
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw);
    if (!user || typeof user !== 'object') return null;
    return { user, token: null };
  } catch {
    return null;
  }
}

export function clearAuth() {
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}