// client/src/api/pluginsApi.js
//
// 插件系统 API 封装。
//
// 【本次改动 · 多页面路由】
//   · 新增 pluginPageUrl(pluginId, ticket, pagePath, params)
//     —— 生成 /api/plugins/:id/p/:ticket/<pagePath>?__params=<json>
//   · pluginEntryUrl 保留（兼容旧调用方；会走 /entry 通道）
//
// 【上一轮 · 版本历史】
//   · listPluginVersions(id)
//   · publishPlugin 支持 changelog
//
import { request, API_BASE } from './http';
import * as session from '../auth/session';

// ============================================================
// 列表 / 详情
// ============================================================
export const listPlugins = ({ scope = 'all', keyword = '' } = {}) => {
  const qs = new URLSearchParams();
  if (scope) qs.set('scope', scope);
  if (keyword) qs.set('keyword', keyword);
  const q = qs.toString() ? `?${qs}` : '';
  return request(`/plugins${q}`);
};

export const getPlugin = (id) =>
  request(`/plugins/${encodeURIComponent(id)}`);

export const listPluginVersions = (id) =>
  request(`/plugins/${encodeURIComponent(id)}/versions`);

// ============================================================
// 上传 / 发布 / 更新
// ============================================================
/**
 * @param {File} file  .plugin 文件（由 plugins-demo/pack-plugin.mjs 生成）
 * @param {{isPublic?:boolean, iconUrl?:string, changelog?:string}} [opts]
 */
export async function publishPlugin(file, opts = {}) {
  const fd = new FormData();
  fd.append('bundle', file, file.name);
  if (opts.isPublic) fd.append('isPublic', '1');
  if (opts.iconUrl) fd.append('iconUrl', opts.iconUrl);
  if (opts.changelog) fd.append('changelog', String(opts.changelog).slice(0, 2000));
  return request('/plugins', { method: 'POST', body: fd, isForm: true });
}

// ============================================================
// 安装 / 卸载
// ============================================================
export const installPlugin = (id, grantedPerms = []) =>
  request(`/plugins/${encodeURIComponent(id)}/install`, {
    method: 'POST',
    body: { grantedPerms }
  });

export const uninstallPlugin = (id) =>
  request(`/plugins/${encodeURIComponent(id)}/uninstall`, { method: 'DELETE' });

// ============================================================
// 分享 / 订阅
// ============================================================
export const sharePlugin = (id, regenerate = false) =>
  request(`/plugins/${encodeURIComponent(id)}/share`, {
    method: 'POST', body: { regenerate }
  });

export const setPluginPrivate = (id) =>
  request(`/plugins/${encodeURIComponent(id)}/private`, { method: 'POST', body: {} });

export const subscribePlugin = (code) =>
  request('/plugins/subscribe', { method: 'POST', body: { code } });

export const deletePlugin = (id) =>
  request(`/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ============================================================
// 管理：单插件操作
// ============================================================
export const delistPlugin = (id, reason = '') =>
  request(`/admin/plugins/${encodeURIComponent(id)}/delist`, {
    method: 'POST', body: { reason }
  });

export const adminHidePlugin = (id, reason = '') =>
  request(`/admin/plugins/${encodeURIComponent(id)}/hide`, {
    method: 'POST', body: { reason }
  });

export const adminRestorePlugin = (id) =>
  request(`/admin/plugins/${encodeURIComponent(id)}/restore`, {
    method: 'POST', body: {}
  });

// ============================================================
// 管理：全量列表 / 统计 / 白名单
// ============================================================
export const adminListPlugins = (
  { status = '', keyword = '', ownerId = null, limit = 100, offset = 0 } = {}
) => {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (keyword) qs.set('keyword', keyword);
  if (ownerId != null) qs.set('ownerId', String(ownerId));
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  return request(`/admin/plugins?${qs}`);
};

export const adminPluginStats = () =>
  request('/admin/plugins/stats');

export const adminPluginWhitelist = () =>
  request('/admin/plugins/whitelist');

// ============================================================
// 支付
// ============================================================
export const getPluginPayInfo = (id, amount = null) => {
  const q = amount !== null && amount !== undefined ? `?amount=${encodeURIComponent(amount)}` : '';
  return request(`/plugins/${encodeURIComponent(id)}/pay-info${q}`);
};

export const payPlugin = ({ pluginId, amount, subject, orderId, metadata }) =>
  request('/plugins/payments', {
    method: 'POST',
    body: { pluginId, amount, subject, orderId, metadata }
  });

export const listMinePluginPayments = (limit = 100) =>
  request(`/plugins/payments/mine?limit=${limit}`);

export const listSellerPluginPayments = (limit = 100) =>
  request(`/plugins/payments/seller?limit=${limit}`);

export const getPluginPayment = (paymentId) =>
  request(`/plugins/payments/${encodeURIComponent(paymentId)}`);

export const refundPluginPayment = (paymentId, reason = '') =>
  request(`/plugins/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST', body: { reason }
  });

export const adminListPluginPayments = ({ limit = 200, pluginId, status } = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  if (pluginId) qs.set('pluginId', pluginId);
  if (status) qs.set('status', status);
  return request(`/admin/plugins/payments?${qs}`);
};

export const adminRefundPluginPayment = (paymentId, reason = '') =>
  request(`/admin/plugins/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST', body: { reason }
  });

export const getPluginPayStats = (id) =>
  request(`/plugins/${encodeURIComponent(id)}/pay-stats`);

// ============================================================
// KV 存储
// ============================================================
export const pluginKvList = (pluginId) =>
  request(`/plugins/${encodeURIComponent(pluginId)}/kv`);

export const pluginKvSet = (pluginId, key, value) =>
  request(`/plugins/${encodeURIComponent(pluginId)}/kv`, {
    method: 'POST', body: { key, value }
  });

export const pluginKvDel = (pluginId, key) =>
  request(`/plugins/${encodeURIComponent(pluginId)}/kv/${encodeURIComponent(key)}`, {
    method: 'DELETE'
  });

export async function pluginKvGet(pluginId, key) {
  const d = await pluginKvList(pluginId);
  const item = (d.items || []).find((i) => i.key === key);
  return item ? item.value : null;
}

// ============================================================
// 代理请求（一次性）
// ============================================================
export const fetchPluginProxy = (pluginId, opts) => {
  const url = typeof opts === 'string' ? opts : opts?.url;
  const method = typeof opts === 'string' ? 'GET' : (opts?.method || 'GET');
  const headers = typeof opts === 'string' ? {} : (opts?.headers || {});
  const body = typeof opts === 'string' ? null : (opts?.body ?? null);

  return request(`/plugins/${encodeURIComponent(pluginId)}/proxy`, {
    method: 'POST',
    body: { url, method, headers, body }
  });
};

// ============================================================
// 代理请求（流式）
// ============================================================
export async function fetchPluginProxyStream(pluginId, opts, _retried = false) {
  const url = typeof opts === 'string' ? opts : opts?.url;
  const method = typeof opts === 'string' ? 'GET' : (opts?.method || 'GET');
  const headers = typeof opts === 'string' ? {} : (opts?.headers || {});
  const body = typeof opts === 'string' ? null : (opts?.body ?? null);

  const reqHeaders = { 'Content-Type': 'application/json' };
  const access = session.getAccessToken();
  if (access) reqHeaders.Authorization = `Bearer ${access}`;

  const res = await fetch(`${API_BASE}/plugins/${encodeURIComponent(pluginId)}/proxy/stream`, {
    method: 'POST',
    headers: reqHeaders,
    credentials: 'include',
    body: JSON.stringify({ url, method, headers, body })
  });

  if (res.status === 401 && !_retried) {
    try {
      await session.refresh();
      return fetchPluginProxyStream(pluginId, opts, true);
    } catch { /* fallthrough */ }
  }

  if (!res.ok) {
    let msg = `流式代理失败 (${res.status})`;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch { /* 可能不是 JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  if (!res.body) throw new Error('响应不支持流式读取');

  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    stream: res.body
  };
}

// ============================================================
// 加载票据 + URL 生成
// ============================================================
export const requestPluginTicket = (pluginId) =>
  request(`/plugins/${encodeURIComponent(pluginId)}/ticket`, {
    method: 'POST', body: {}
  });

/**
 * [CHANGED · 多页面] 生成页面 URL（走 /p/ 通道，会注入 base + 桥）。
 * @param {string} pluginId
 * @param {string} ticket
 * @param {string} pagePath  形如 'pages/index/index.html'
 * @param {object} [params]  页面入参 → 序列化到 ?__params=
 */
export function pluginPageUrl(pluginId, ticket, pagePath, params) {
  const p = String(pagePath || '').replace(/^\/+/, '');
  const base = `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/p/${encodeURIComponent(ticket)}/${p}`;
  if (params && typeof params === 'object' && Object.keys(params).length > 0) {
    return `${base}?__params=${encodeURIComponent(JSON.stringify(params))}`;
  }
  return base;
}

/**
 * 兼容旧接口：走 /entry 通道（只加载 manifest.pages[0]）。
 * 新代码请用 pluginPageUrl。
 */
export function pluginEntryUrl(pluginId, ticket) {
  return `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/entry?t=${encodeURIComponent(ticket)}`;
}

/**
 * 兼容旧接口：走 /asset 通道（query 形式）。
 * 新代码请用 /a/:ticket/* 路径形式 —— 它在 /plugins 的 base 下会被自然拼接。
 */
export function pluginAssetUrl(pluginId, ticket, relPath) {
  const p = String(relPath || '').replace(/^\/+/, '');
  return `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/asset?t=${encodeURIComponent(ticket)}&path=${encodeURIComponent(p)}`;
}