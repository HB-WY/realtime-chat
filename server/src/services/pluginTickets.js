// src/services/pluginTickets.js
//
// 插件加载票据（短时、绑定用户 + 插件、不落库）。
//
// 为什么需要：
//   iframe 里 <script src> / <link href> / <img src> 无法携带 Authorization 头，
//   而插件的 bundle 目录**不静态暴露**（防"直接猜路径"攻击宿主）。
//   所以走「一次性票据」方案：
//     1) 前端 POST /plugins/:id/ticket → { ticket, expireAt }
//     2) 拼进 URL：/plugins/:id/entry?t=xxx、/plugins/:id/asset?t=xxx&path=...
//     3) 服务端在**内存**里校验：票据未过期 + 只能用于该插件
//
// [SEC] 票据只解决"资源能带鉴权"这一个问题；真正的权限检查在 entry 端点
//   里做（"用户是否已安装该插件"）。所以即使票据被泄露，攻击者也只能用它
//   去读"它本来就有权读的插件"。
//
const crypto = require('crypto');

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;

/** ticket → { userId, pluginId, expireAt } */
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expireAt <= now) store.delete(k);
  }
}

const pruneTimer = setInterval(prune, 30 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

/**
 * 生成票据。
 * @param {number} userId
 * @param {string} pluginId
 * @returns {{ticket:string, expireAt:number}}
 */
function issue(userId, pluginId) {
  if (store.size >= MAX_ENTRIES) prune();
  const ticket = crypto.randomBytes(24).toString('hex');
  const expireAt = Date.now() + TTL_MS;
  store.set(ticket, { userId, pluginId, expireAt });
  return { ticket, expireAt };
}

/**
 * 校验票据（**不消耗**：一次打开会连着请求 entry + css + js + img）。
 * 同一票据在 TTL 内可以多次使用。
 * @param {string} ticket
 * @param {string} [expectPluginId]  若提供，则必须匹配
 * @returns {{userId:number, pluginId:string}|null}
 */
function verify(ticket, expectPluginId = null) {
  if (typeof ticket !== 'string' || !ticket) return null;
  const rec = store.get(ticket);
  if (!rec) return null;
  if (rec.expireAt <= Date.now()) { store.delete(ticket); return null; }
  if (expectPluginId && rec.pluginId !== expectPluginId) return null;
  return { userId: rec.userId, pluginId: rec.pluginId };
}

function revoke(ticket) {
  store.delete(ticket);
}

function revokeAll(userId, pluginId) {
  for (const [k, v] of store) {
    if (v.userId === userId && v.pluginId === pluginId) store.delete(k);
  }
}

function stats() {
  return { size: store.size, ttlMs: TTL_MS };
}

module.exports = { issue, verify, revoke, revokeAll, stats, TTL_MS };