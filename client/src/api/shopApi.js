// client/src/api/shopApi.js
//
// [CHANGED] 认证改造后所有 API 都从 http.js 的内存读 Access Token，
//   不再需要在签名里传 token 参数。
//
// [NOTE] downloadFile / previewFileBlob 走裸 fetch 是为了拿 Blob；
//   它们不会走 http.js 的 401 自动刷新（因为返回体不是 JSON）。
//   若需要下载路径也支持自动刷新，可以后续把 request() 扩展成
//   「响应类型可选」，或者在下面两个函数里手写一次 401 → refresh → 重试。
//
import { request, API_BASE } from './http';
import { prepareImage, MB } from '../utils/image';
import * as session from '../auth/session';

// ── 积分 ──────────────────────────────────────────
export const getMyPoints = () => request('/points/me');

export const getPointsHistory = (limit = 50) =>
  request(`/points/transactions?limit=${limit}`);

// ── 能力表 ────────────────────────────────────────
export const getMyCapabilities = () => request('/me/capabilities');

// ── 商品 ──────────────────────────────────────────
export const listMarket = (market, keyword = '', category = '') => {
  const qs = new URLSearchParams();
  if (keyword) qs.set('keyword', keyword);
  if (category) qs.set('category', category);
  const q = qs.toString() ? `?${qs}` : '';
  return request(`/shop/market/${market}${q}`);
};

export const getShopCatalog = () => request('/shop/catalog');

export const getProduct = (id) => request(`/shop/products/${id}`);

export const buyProduct = (id) =>
  request(`/shop/products/${id}/buy`, { method: 'POST', body: {} });

export const listMine = () => request('/shop/mine');
export const listOrders = () => request('/shop/orders');

// 商品「内容文件」是交付物，**不做任何压缩/转码**，原样上传。
export async function uploadShopFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('name', file.name);
  return request('/shop/upload', { method: 'POST', body: fd, isForm: true });
}

// 商品封面只是展示图，压缩后再传（手机相册直接选图也能用）
export async function uploadShopCover(file) {
  const ready = await prepareImage(file, {
    maxDim: 1600, maxBytes: 3.5 * MB, label: '封面图'
  });
  const fd = new FormData();
  fd.append('cover', ready);
  return request('/shop/cover', { method: 'POST', body: fd, isForm: true });
}

export const createProduct = (payload) =>
  request('/shop/products', { method: 'POST', body: payload });

// ────────────────────────────────────────────────
// 内部：给裸 fetch 补 Authorization 头
// ────────────────────────────────────────────────
function authHeaders() {
  const t = session.getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 文件下载：后端鉴权后回传 Blob，前端全程不接触真实 URL */
export async function downloadFile(productId, fileId) {
  const res = await fetch(`${API_BASE}/shop/download/${productId}/${fileId}`, {
    headers: authHeaders(),
    credentials: 'include'
  });
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.blob();
}

/**
 * 试看 / 预览：**登录即可，不需要购买**。
 * 服务端只对卖家勾了「预览」的文件放行（product_files.is_preview = 1），
 * 所以它天然是「京东那种先看图、买后再下载」的模型，而不是绕过付费。
 * 商品文件放在 uploads/shop（未静态暴露），必须先取 Blob 再转 objectURL。
 *
 * @param {{playback?:boolean}} [opts] playback=true 时服务端给「浏览器播得了的那份」：
 *   源格式播不了（mkv/avi/wmv/flac…）就用本地 ffmpeg 转码，于是
 *     200 → 拿到可播文件（原件或转码副本）；
 *     202 → 还在转码，err.status = 202、err.data.progress 是进度；
 *     409 → 转码失败，err.message 里是原因。
 */
export async function previewFileBlob(productId, fileId, { playback = false } = {}) {
  const qs = playback ? '?playback=1' : '';
  const res = await fetch(`${API_BASE}/shop/preview/${productId}/${fileId}${qs}`, {
    headers: authHeaders(),
    credentials: 'include'
  });
  if (!res.ok) {
    let msg = `预览失败 (${res.status})`;
    let data = null;
    try {
      data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return res.blob();
}