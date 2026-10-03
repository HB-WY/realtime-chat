import { request } from './http';

// ── 房间设置 ────────────────────────────────────────
// 公共聊天（roomType = 'public'）不是数据库实体，它的图标单独存放，
// 由开发者维护（能力位 manage_public_room）。
// 群图标走 groups.avatar：群主 / 群管理员可改（socket group:update）。

/** 公共聊天房信息：{ roomKey, type, name, icon, updatedAt } */
export const getPublicRoom = () => request('/rooms/public');

/** 更换公共聊天图标：icon 为 /uploads/... URL、http(s) 链接或单个 emoji；空串＝清除 */
export const setPublicRoomIcon = (icon) =>
  request('/rooms/public/icon', { method: 'PUT', body: { icon } });