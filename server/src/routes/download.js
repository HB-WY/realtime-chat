// src/routes/download.js
//
// 【本次改动】
//   1) /shop/preview 加商品状态校验：以前只查 product_files.is_preview，
//      商品下架 / 盗版后仍能拉预览 —— 与下载通道的权限判断不一致。
//   2) **卖家本人 / 管理员豁免状态检查**：他们需要审核 / 确认自己上传的
//      文件，不能因为商品处于 pending_review / delisted 就看不到。
//   3) sticker_pack 商品：preview 与 download 都拒绝。
//      表情包商品一旦购买就整包入库，不提供单张下载 —— 否则等于给了一条
//      单张扒取的通道，与「不可下载，只能添加到表情包库」的需求冲突。
//
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const config = require('../config');
const { authMiddleware } = require('../auth');
const { isAdmin, audit } = require('../services/permissions');
const transcode = require('../services/transcode');
const { clientIp } = require('../utils/ip');

const router = express.Router();

// ============================================================
// 限流
// ============================================================
function makeRateLimiter(cfg, label) {
  const windowMs = cfg.window_ms;
  const max = cfg.max;
  const hits = new Map();
  let ops = 0;

  function prune() {
    const now = Date.now();
    for (const [uid, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length === 0) hits.delete(uid);
      else if (kept.length !== arr.length) hits.set(uid, kept);
    }
  }

  const timer = setInterval(prune, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    check(userId) {
      const now = Date.now();
      const recent = (hits.get(userId) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(userId, recent);
        const wait = Math.ceil((windowMs - (now - recent[0])) / 1000);
        return { ok: false, wait, label };
      }
      recent.push(now);
      hits.set(userId, recent);
      if (++ops >= 500) { ops = 0; prune(); }
      return { ok: true };
    }
  };
}

const downloadLimiter = makeRateLimiter(config.RATE_LIMITS.download, '下载');
const previewLimiter = makeRateLimiter(config.RATE_LIMITS.preview, '预览');

function setProtectedHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function checkReferer(req) {
  if (config.ALLOWED_REFERER_HOSTS.length === 0) return true;
  const ref = req.headers.referer || req.headers.origin || '';
  if (!ref) return false;
  try {
    const host = new URL(ref).host;
    return config.ALLOWED_REFERER_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function canDownload(userId, role, productId) {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!prod) return { ok: false, code: 404, msg: '商品不存在' };
  if (prod.seller_id === userId) return { ok: true, product: prod };
  if (isAdmin(role)) return { ok: true, product: prod };

  const bought = db.prepare(
    "SELECT 1 FROM orders WHERE product_id = ? AND buyer_id = ? AND status = 'paid'"
  ).get(productId, userId);
  if (bought) return { ok: true, product: prod };

  return { ok: false, code: 403, msg: '未购买该商品' };
}

// ============================================================
// 下载（走鉴权）
// ============================================================
router.get('/shop/download/:productId/:fileId', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;
  const productId = Number(req.params.productId);
  const fileId = Number(req.params.fileId);

  if (!checkReferer(req)) {
    audit(userId, role, 'download_referer_block', 'product', productId,
          `Referer=${req.headers.referer || 'none'}`);
    return res.status(403).json({ error: '非法来源' });
  }

  const rate = downloadLimiter.check(userId);
  if (!rate.ok) {
    return res.status(429).json({ error: `${rate.label}过于频繁，请 ${rate.wait} 秒后重试` });
  }

  const perm = canDownload(userId, role, productId);
  if (!perm.ok) {
    return res.status(perm.code).json({ error: perm.msg });
  }

  // 表情包商品：不提供文件下载通道。
  //   购买后买家已在 sticker_packs 里拿到整包，聊天界面直接用。
  if ((perm.product.category || 'goods') === 'sticker_pack') {
    return res.status(403).json({
      error: '表情包商品不提供文件下载：购买后可在「表情包」里直接使用'
    });
  }

  const pf = db.prepare(
    'SELECT * FROM product_files WHERE id = ? AND product_id = ?'
  ).get(fileId, productId);
  if (!pf) return res.status(404).json({ error: '文件不存在' });

  const rel = pf.file_url.replace(/^\/uploads\/shop\//, '');
  const abs = path.join(config.SHOP_DIR, rel);
  const normalized = path.resolve(abs);
  // [SEC] 前缀比较必须带路径分隔符：`uploads/shop-evil/x` 能通过
  //       不带 sep 的 startsWith 检查（与 assets.isInsideDir 口径对齐）
  const shopRoot = path.resolve(config.SHOP_DIR);
  if (normalized !== shopRoot && !normalized.startsWith(shopRoot + path.sep)) {
    return res.status(400).json({ error: '非法路径' });
  }
  if (!fs.existsSync(normalized)) {
    return res.status(404).json({ error: '文件已丢失' });
  }

  db.prepare(
    `INSERT INTO download_logs (user_id, product_id, file_id, ip, ua, referer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, productId, fileId,
    clientIp(req),
    (req.headers['user-agent'] || '').slice(0, 500),
    (req.headers.referer || '').slice(0, 500),
    Date.now()
  );

  setProtectedHeaders(res);
  res.download(normalized, pf.file_name, (err) => {
    if (err) {
      console.error('[download]', err);
      if (!res.headersSent) res.status(500).json({ error: '下载失败' });
    }
  });
});

// ============================================================
// 预览 / 试看（未购买可看）
//
// 权限规则（与下载通道保持一致的思路）：
//   · 卖家本人 / 管理员：不受商品状态限制，也**不受 is_preview 限制**
//     （要审核 / 确认自己传的文件 —— 尤其是漏勾「预览」时）
//   · 其他用户：商品必须 on_sale，且该文件 is_preview = 1
//   · 表情包商品：任何情况下都不提供单张预览（防止单张扒取）
// ============================================================
router.get('/shop/preview/:productId/:fileId', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const fileId = Number(req.params.fileId);

    const rate = previewLimiter.check(req.user.id);
    if (!rate.ok) {
      return res.status(429).json({ error: `${rate.label}过于频繁，请 ${rate.wait} 秒后重试` });
    }

    const prod = db.prepare(
      'SELECT id, status, category, seller_id FROM products WHERE id = ?'
    ).get(productId);
    if (!prod) return res.status(404).json({ error: '商品不存在' });

    // 表情包商品：任何角色都不提供单张预览。
    // 卖家要确认自己传了什么，可以用「我发布的 → 查看文件」走下载通道看原件，
    // 不需要通过预览通道。
    if ((prod.category || 'goods') === 'sticker_pack') {
      return res.status(403).json({
        error: '表情包不提供单张预览，购买后可在「表情包」里直接使用'
      });
    }

    // 卖家 / 管理员豁免商品状态检查：
    //   审核流程要求管理员能看到 pending_review 商品的文件；
    //   卖家本人也需要确认自己上传的内容。
    //   其他用户只能在商品 on_sale 时预览。
    const isOwner = prod.seller_id === req.user.id;
    const isAdminUser = isAdmin(req.user.role);
    if (!isOwner && !isAdminUser && prod.status !== 'on_sale') {
      return res.status(404).json({ error: '商品当前不可预览' });
    }

    // [FIX] 卖家 / 管理员不受 is_preview 约束。
    //   原先对**所有角色**都要求 is_preview = 1 —— 卖家上传时忘勾「预览」，
    //   自己也打不开；审核员要打开 pending_review 商品的文件看内容，
    //   同样 404。这与上面注释里承诺的"卖家本人 / 管理员不受限制"不符。
    //   其他用户仍然只放行 is_preview = 1（"先看图、买后再下载"的语义）。
    const pf = (isOwner || isAdminUser)
      ? db.prepare(
          'SELECT * FROM product_files WHERE id = ? AND product_id = ?'
        ).get(fileId, productId)
      : db.prepare(
          'SELECT * FROM product_files WHERE id = ? AND product_id = ? AND is_preview = 1'
        ).get(fileId, productId);
    if (!pf) return res.status(404).json({ error: '预览文件不存在' });

    const rel = pf.file_url.replace(/^\/uploads\/shop\//, '');
    const abs = path.join(config.SHOP_DIR, rel);
    const normalized = path.resolve(abs);
    // [SEC] 同上：带分隔符的前缀校验
    const shopRoot = path.resolve(config.SHOP_DIR);
    if (normalized !== shopRoot && !normalized.startsWith(shopRoot + path.sep)) {
      return res.status(400).json({ error: '非法路径' });
    }
    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ error: '文件已丢失' });
    }

    // ?playback=1 —— 播放器专用：要的是「浏览器播得了的那份」
    if (req.query.playback === '1') {
      const info = await transcode.describe(normalized);
      if (info.needed && info.status !== 'ready') {
        if (info.status === 'failed') {
          return res.status(409).json({ status: 'failed', error: `转码失败：${info.error || '未知原因'}` });
        }
        return res.status(202).json({ status: 'pending', progress: info.progress, error: null });
      }
      if (info.needed && info.playUrl) {
        const copyRel = info.playUrl.replace(/^\/uploads\/shop\//, '');
        const copyAbs = path.resolve(path.join(config.SHOP_DIR, copyRel));
        if ((copyAbs === shopRoot || copyAbs.startsWith(shopRoot + path.sep)) && fs.existsSync(copyAbs)) {
          setProtectedHeaders(res);
          return res.sendFile(copyAbs);
        }
        return res.status(409).json({ status: 'failed', error: '转码副本丢失' });
      }
    }

    setProtectedHeaders(res);
    res.sendFile(normalized);
  } catch (err) {
    // [FIX] Express 4 不捕获 async handler 的 rejection：
    //       describe() 抛错会变成 unhandledRejection（可致进程退出）
    console.error('[preview]', err);
    if (!res.headersSent) res.status(500).json({ error: '预览失败' });
  }
});
module.exports = router;