// client/src/api/paymentsApi.js
//
// 支付系统（转账 / 红包）API 封装。
//
// 与 socket 事件互补：
//   实时变化（新转账、被收款、被退还、有人抢了红包）走 socket；
//   "拉一次历史 / 详情"走 REST。两条通道共用同一套 services。
//
import { request } from './http';

// ============================================================
// 转账
// ============================================================
export const createTransfer = ({ toUserId, amount, note }) =>
  request('/transfers', {
    method: 'POST', body: { toUserId, amount, note }
  });

export const acceptTransfer = (id) =>
  request(`/transfers/${id}/accept`, { method: 'POST', body: {} });

export const rejectTransfer = (id) =>
  request(`/transfers/${id}/reject`, { method: 'POST', body: {} });

export const getTransfer = (id) =>
  request(`/transfers/${id}`);

/** role: 'send' | 'receive' | 'all' */
export const listTransfers = (role = 'all') =>
  request(`/transfers/mine?role=${encodeURIComponent(role)}`);

// ============================================================
// 红包
// ============================================================
export const createRedPacket = ({ roomType, roomId, totalAmount, count, mode, note }) =>
  request('/redpackets', {
    method: 'POST',
    body: { roomType, roomId, totalAmount, count, mode, note }
  });

export const grabRedPacket = (id) =>
  request(`/redpackets/${id}/grab`, { method: 'POST', body: {} });

export const getRedPacket = (id) =>
  request(`/redpackets/${id}`);

export const listRedPackets = (role = 'all') =>
  request(`/redpackets/mine?role=${encodeURIComponent(role)}`);