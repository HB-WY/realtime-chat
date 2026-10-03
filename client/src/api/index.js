// client/src/api/index.js
//
// API 模块的统一出口。
//
// [CHANGED] 认证改造后：
//   · register / login / logout 已移到 `auth/session.js`（它们不走 request，
//     而是自己管 refresh + accessToken 的内存状态）
//   · 其余 12 个模块继续从各自文件导出
//
export * from './authApi';
export * from './shopApi';
export * from './adminApi';
export * from './roleApi';
export * from './preferencesApi';
export * from './assetsApi';
export * from './stickersApi';
export * from './apikeysApi';
export * from './roomsApi';
export * from './mediaApi';
export * from './pluginsApi';
// 【新增】支付系统（转账 / 红包）
export * from './paymentsApi';
export { request, API_BASE } from './http';