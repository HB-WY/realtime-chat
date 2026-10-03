import { request } from './http';

// ── API 密钥（脚本通道，独立于浏览器 JWT/Cookie） ─────────────
//
// [SEC] 每把密钥绑定**申请时**的来源 IP，从其他 IP 使用会被 403 拒绝。
//   浏览器登录走 Cookie 通道，脚本调用走密钥通道（X-API-Key）。

/** @returns {Promise<{key:string, prefix:string, masked:string, id:number, boundIp:string}>} */
export const createApiKey = (name = '') =>
  request('/keys', { method: 'POST', body: { name } });

export const listApiKeys = () => request('/keys');

export const revokeApiKey = (id) =>
  request(`/keys/${id}/revoke`, { method: 'POST', body: {} });

// ── 管理员：IP 绑定 ───────────────────────────────
export const listIpClaims = (all = false) =>
  request(`/admin/apikeys/ip-claims${all ? '?all=1' : ''}`);

export const releaseIpClaim = (payload) =>
  request('/admin/apikeys/ip-claims/release', { method: 'POST', body: payload });