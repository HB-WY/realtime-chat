import { request } from './http';
import { prepareImages, MB } from '../utils/image';

// ── 表情包 ────────────────────────────────────────

export const listStickerPacks = () => request('/stickers/packs');

export const createStickerPack = (payload) =>
  request('/stickers/packs', { method: 'POST', body: payload });

export const getStickerPack = (id) => request(`/stickers/packs/${id}`);

export const updateStickerPack = (id, payload) =>
  request(`/stickers/packs/${id}`, { method: 'PATCH', body: payload });

export const deleteStickerPack = (id) =>
  request(`/stickers/packs/${id}`, { method: 'DELETE' });

/** 批量上传表情图片（≤10MB/张，≤50 张/次）；表情是小图，压到 512px 够用 */
export async function uploadStickerItems(packId, files) {
  const list = await prepareImages(files, {
    maxDim: 512, maxBytes: 2 * MB, label: '表情图片'
  });
  const fd = new FormData();
  for (const f of list) fd.append(list.length > 1 ? 'files' : 'file', f, f.name);
  return request(`/stickers/packs/${packId}/items`, {
    method: 'POST', body: fd, isForm: true
  });
}

export const reorderStickerItems = (packId, order) =>
  request(`/stickers/packs/${packId}/items/order`, {
    method: 'PUT', body: { order }
  });

export const removeStickerItem = (packId, itemId) =>
  request(`/stickers/packs/${packId}/items/${itemId}`, { method: 'DELETE' });

/** 生成（或重新生成）分享码并把表情包设为公开 */
export const shareStickerPack = (packId, regenerate = false) =>
  request(`/stickers/packs/${packId}/share`, {
    method: 'POST', body: { regenerate }
  });

export const setStickerPackPrivate = (packId) =>
  request(`/stickers/packs/${packId}/private`, { method: 'POST', body: {} });

/** 凭分享码订阅：只建关联，不复制文件 */
export const subscribeStickerPack = (code) =>
  request('/stickers/subscribe', { method: 'POST', body: { code } });

export const unsubscribeStickerPack = (packId) =>
  request(`/stickers/subscribe/${packId}`, { method: 'DELETE' });

/**
 * [NEW] 通过表情 URL 反查：它属于哪个表情包、我是否拥有 / 订阅，
 * 以及（若该表情包来自商城购买）对应的商品 id。
 */
export const lookupSticker = (url) =>
  request(`/stickers/lookup?url=${encodeURIComponent(url)}`);