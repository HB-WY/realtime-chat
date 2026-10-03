import { request } from './http';
import { prepareImages, MB } from '../utils/image';

// ── 统一资源池 ────────────────────────────────────
// 图片：PNG / JPG / GIF / WebP / BMP / AVIF（GIF 原样保留动画，
// 其余大图上传前会等比压缩）。单次上传合计 ≤500MB，
// 总量配额默认不限（后端按 sha256 去重，落盘 uploads/custom/{userId}/）。
// kind: 'image' | 'background' | 'bubble' | 'sticker'

export const listAssets = (kind) =>
  request(`/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);

export const getAssetQuota = () => request('/assets/quota');

export const getAsset = (id) => request(`/assets/${id}`);

export const deleteAsset = (id) =>
  request(`/assets/${id}`, { method: 'DELETE' });

/** 上传单张或多张图片，返回 { asset, assets, created, deduped, usage } */
export async function uploadAssets(files, kind = 'image') {
  const list = await prepareImages(files, {
    maxDim: 2560, maxBytes: 8 * MB, label: '图片'
  });
  const fd = new FormData();
  for (const f of list) fd.append(list.length > 1 ? 'files' : 'file', f, f.name);
  fd.append('kind', kind);
  return request('/assets/upload', { method: 'POST', body: fd, isForm: true });
}