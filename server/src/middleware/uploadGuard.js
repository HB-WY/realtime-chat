// src/middleware/uploadGuard.js
//
// [NEW] 上传通道按用户限流（滑动窗口，进程内 Map）。
//
// 背景：聊天附件 / 商品文件 / 头像 / 封面 / 资源池各上传接口此前
// **没有任何频率限制**（资源池只有总量配额），认证用户可以循环
// 上传大文件写满磁盘（DoS）。总量配额按需求已放开（quota_bytes: 0），
// 因此频率维度成为唯一防线。
//
// 用法：挂在 authMiddleware 之后：
//   router.post('/file', authMiddleware, uploadGuard, handler)
//
const config = require('../config');

const RL = config.RATE_LIMITS.upload || {};
const WINDOW_MS = Number(RL.window_ms) > 0 ? Number(RL.window_ms) : 60000;
const MAX = Number(RL.max) > 0 ? Number(RL.max) : 20;

const hits = new Map();
let ops = 0;

function prune() {
  const now = Date.now();
  for (const [uid, arr] of hits) {
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) hits.delete(uid);
    else if (kept.length !== arr.length) hits.set(uid, kept);
  }
}

const pruneTimer = setInterval(prune, 5 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

function uploadGuard(req, res, next) {
  const uid = req.user?.id;
  if (!uid) return next(); // 未认证的请求由后续 auth 语义处理

  const now = Date.now();
  const arr = (hits.get(uid) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) {
    const wait = Math.ceil((WINDOW_MS - (now - arr[0])) / 1000);
    hits.set(uid, arr);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `上传过于频繁，请 ${wait} 秒后再试` });
  }
  arr.push(now);
  hits.set(uid, arr);
  if (++ops >= 500) { ops = 0; prune(); }
  next();
}

module.exports = uploadGuard;
