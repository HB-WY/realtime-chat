import { request } from './http';

export const requestRolePromotion = (toRole, reason = '') =>
  request('/roles/request', { method: 'POST', body: { toRole, reason } });

export const getMyRoleRequests = () => request('/roles/my-requests');

export const getPendingRoleRequests = () => request('/roles/pending');

export const reviewRoleRequest = (id, approve, note = '') =>
  request(`/roles/review/${id}`, {
    method: 'POST',
    body: { approve, note }
  });

export const grantRole = (userId, role) =>
  request(`/roles/grant/${userId}`, { method: 'POST', body: { role } });