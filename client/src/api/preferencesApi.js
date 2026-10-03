import { request } from './http';

// ── 个性化偏好 ────────────────────────────────────
// 结构：{ global: {background, bubble, fontSize, updatedAt},
//         rooms:  { "<roomKey>": {roomKey, background, updatedAt} },
//         limits: {...} }
// 未设置时字段为 null —— 前端据此保持现状表现。

export const getPreferences = () => request('/preferences');

/** payload: { global?: {...}, room?: {roomKey, background} } */
export const savePreferences = (payload) =>
  request('/preferences', { method: 'PUT', body: payload });

export const setRoomBackground = (roomKey, background) =>
  request(`/preferences/room/${encodeURIComponent(roomKey)}`, {
    method: 'PUT', body: { background }
  });

export const clearRoomBackground = (roomKey) =>
  request(`/preferences/room/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE'
  });