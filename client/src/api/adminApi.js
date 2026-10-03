import { request } from './http';

export const adminListUsers = (keyword = '') => {
  const q = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
  return request(`/admin/users${q}`);
};

export const adminSetUserStatus = (userId, status, reason = '') =>
  request(`/admin/users/${userId}/status`, {
    method: 'POST',
    body: { status, reason }
  });

export const adminDelistProduct = (id, reason = '') =>
  request(`/admin/shop/delist/${id}`, { method: 'POST', body: { reason } });

export const adminHideProduct = (id, reason = '') =>
  request(`/admin/shop/hide/${id}`, { method: 'POST', body: { reason } });

export const adminUnhideProduct = (id) =>
  request(`/admin/shop/unhide/${id}`, { method: 'POST', body: {} });

export const adminPendingReview = () =>
  request('/admin/shop/pending-review');

export const adminReviewPrice = (id, price, note = '') =>
  request(`/admin/shop/review/${id}`, {
    method: 'POST',
    body: { price, note }
  });

export const adminAuditLogs = (limit = 100) =>
  request(`/admin/audit?limit=${limit}`);