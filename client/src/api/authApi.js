// client/src/api/authApi.js
//
// [CHANGED] 认证改造后，register / login 由 `auth/session.js` 负责
//   （内部把 accessToken 存内存、收 Refresh Cookie），不再走这里。
//   这里只保留"更新资料"和"上传"。
//
import { request } from './http';
import { prepareImage, MB } from '../utils/image';

export const updateProfile = (payload) =>
  request('/me', { method: 'PATCH', body: payload });

// 【新增】用户公开资料（点击头像弹出的用户卡片用）
export const getUserProfile = (userId) =>
  request(`/users/${userId}`);

export async function uploadAvatar(file) {
  const ready = await prepareImage(file, { maxDim: 1024, maxBytes: 3.5 * MB, label: '头像' });
  const fd = new FormData();
  fd.append('avatar', ready);
  fd.append('name', ready.name);
  return request('/avatar', { method: 'POST', body: fd, isForm: true });
}

export async function uploadFile(file) {
  const ready = await prepareImage(file, { maxDim: 2560, maxBytes: 8 * MB, label: '图片' });
  const fd = new FormData();
  fd.append('file', ready);
  fd.append('name', ready.name);
  return request('/file', { method: 'POST', body: fd, isForm: true });
}