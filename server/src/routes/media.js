// src/routes/media.js
//
// 音视频附件的「能不能直接播 / 转好了没」查询口。
//
// 为什么需要它：转码是后台异步跑的（见 services/transcode.js），上传接口
// 只能当场回一句「要不要转、转到哪个地址」，转完没有没法当场知道。
// 客户端（以及历史消息里的老附件）统一问这个接口：
//
//   GET /api/media/status?src=/uploads/files/1790_ab12cd.mkv
//   → { needed:true, status:'pending'|'ready'|'failed'|'not_needed'|'unavailable',
//       playUrl:'/uploads/files/tc/1790_ab12cd.mp4', progress:0.42, error:null }
//
// 两个语义要点：
//   · **幂等**：问到一个「该转但没人转」的文件时顺手入队 —— 这样历史消息里
//     的老附件、以及后端重启后丢掉队列的任务，都会在第一次被播放时自愈；
//   · 只受理 uploads/files 下的**单层文件名**（聊天附件本来就平铺存放）。
//     商城文件是付费交付物、目录不静态暴露，它走 /api/shop/preview/... 鉴权通道。
//
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { authMiddleware } = require('../auth');
const transcode = require('../services/transcode');

const router = express.Router();

// 单层文件名：不带任何路径分隔符，也就不存在穿越
const FILE_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;

// ============================================================
// [NEW] 按用户限流：describe() 会顺手入队转码（吃 CPU），
//       不限流的话任何登录用户都能对任意附件触发全量转码。
// ============================================================
const MS_RL = config.RATE_LIMITS.media_status || {};
const MS_WINDOW_MS = Number(MS_RL.window_ms) > 0 ? Number(MS_RL.window_ms) : 60000;
const MS_MAX = Number(MS_RL.max) > 0 ? Number(MS_RL.max) : 120;

const msHits = new Map();
let msOps = 0;
function msPrune() {
  const now = Date.now();
  for (const [uid, arr] of msHits) {
    const kept = arr.filter((t) => now - t < MS_WINDOW_MS);
    if (kept.length === 0) msHits.delete(uid);
    else if (kept.length !== arr.length) msHits.set(uid, kept);
  }
}
const msPruneTimer = setInterval(msPrune, 5 * 60 * 1000);
if (typeof msPruneTimer.unref === 'function') msPruneTimer.unref();

function mediaStatusAllowed(userId) {
  const now = Date.now();
  const arr = (msHits.get(userId) || []).filter((t) => now - t < MS_WINDOW_MS);
  if (arr.length >= MS_MAX) {
    msHits.set(userId, arr);
    return false;
  }
  arr.push(now);
  msHits.set(userId, arr);
  if (++msOps >= 500) { msOps = 0; msPrune(); }
  return true;
}

router.get('/media/status', authMiddleware, async (req, res) => {
  if (!mediaStatusAllowed(req.user.id)) {
    return res.status(429).json({ error: '查询过于频繁，请稍后再试' });
  }
  const src = String(req.query.src || '');
  const prefix = '/uploads/files/';
  if (!src.startsWith(prefix)) {
    return res.status(400).json({ error: '只支持查询 /uploads/files/ 下的附件' });
  }
  const name = src.slice(prefix.length);
  if (!FILE_NAME_RE.test(name) || name.includes('..')) {
    return res.status(400).json({ error: '附件地址不合法' });
  }

  const abs = path.resolve(path.join(config.FILE_DIR, name));
  if (!abs.startsWith(path.resolve(config.FILE_DIR) + path.sep)) {
    return res.status(400).json({ error: '附件地址不合法' });
  }
  if (!fs.existsSync(abs)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    const info = await transcode.describe(abs);
    res.json({ src, ...info });
  } catch (err) {
    console.error('[media] status', err);
    res.status(500).json({ error: '查询转码状态失败' });
  }
});

// 诊断口：ffmpeg 有没有就绪、队列里有多少活（排查「为什么不转码」用）
router.get('/media/transcode', authMiddleware, (req, res) => {
  const det = transcode.detect();
  res.json({
    available: det.ok,
    version: det.version || null,
    error: det.error || null,
    ...transcode.stats()
  });
});

module.exports = router;
