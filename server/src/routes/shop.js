// src/routes/shop.js
const express = require('express');
const path = require('path');
const { db } = require('../db');
const config = require('../config');
const { authMiddleware } = require('../auth');
const { can, levelOf, ROLES, CAPABILITIES, GRANTABLE_BY } = require('../services/permissions');
const { getBalance, getTransactions } = require('../services/points');
const { createProduct, purchaseProduct, getProductDetail } = require('../services/products');
const { uploadShopFile, uploadCover } = require('../middleware/upload');
const uploadGuard = require('../middleware/uploadGuard');
const transcode = require('../services/transcode');

const SHOP_CFG = config.BUSINESS.shop;

const router = express.Router();

// ============================================================
// 能力表
// ============================================================
router.get('/me/capabilities', authMiddleware, (req, res) => {
  const role = req.user.role;
  const caps = {};
  for (const [name, needLevel] of Object.entries(CAPABILITIES)) {
    caps[name] = role === 'developer' || levelOf(role) >= needLevel;
  }
  res.json({
    role,
    label: ROLES[role]?.label || role,
    level: levelOf(role),
    capabilities: caps,
    grantable: GRANTABLE_BY[role] || []
  });
});

// ============================================================
// 积分
// ============================================================
router.get('/points/me', authMiddleware, (req, res) => {
  res.json(getBalance(req.user.id));
});

router.get('/points/transactions', authMiddleware, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ transactions: getTransactions(req.user.id, limit) });
});

// ============================================================
// 上传
//
// [CHANGED] 商品文件 / 封面上传对所有登录用户开放：
//   list_products(50) 原本拦的是**全部**上架通道，普通用户（level 0）
//   连跳蚤市场 / 标准市场都进不去 —— 与「跳蚤市场 = 用户自主上架」的
//   定位矛盾。现在只有**官方市场**（market='official'）受
//   official_publish(50) 拦截；上传通道仅保留按用户的频率限流。
// ============================================================
router.post('/shop/upload', authMiddleware, uploadGuard, (req, res) => {
  uploadShopFile.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.SHOP_FILE_MAX / 1048576);
        return res.status(400).json({ error: `文件不能超过 ${mb}MB` });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到文件' });

    // [FIX] Express 4 不会捕获 async handler 的 rejection：
    //   下面任何一步抛错（db.prepare().run() 唯一约束冲突 /
    //   transcode.describe() 意外 throw）都会变成 unhandledRejection，
    //   而本项目没有 process.on('unhandledRejection') 兜底 → 进程可能被带走。
    //   与 routes/download.js::/shop/preview 的 async 分支口径一致：
    //   用 try/catch 包住，统一转成 400 + 日志。
    try {
      const originalName = (req.body?.name || req.file.originalname || '未命名').toString().slice(0, 200);
      const url = `/uploads/shop/${req.file.filename}`;

      // [SEC] 记录归属：createProduct 校验 file_url 只能引用本人上传的文件
      db.prepare(
        `INSERT OR REPLACE INTO shop_uploads (owner_id, file_url, file_name, file_size, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(req.user.id, url, originalName, req.file.size, Date.now());

      // 商品文件本身原样交付（download 通道永远给原件），但**试看**要能播：
      // 音视频交一份转码计划回去，后端后台产出可播副本（uploads/shop/tc/，
      // 不静态暴露，只走 /api/shop/preview?playback=1 的鉴权通道）。
      const mime = (req.file.mimetype || '').toLowerCase();
      let playback = null;
      if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        try {
          playback = await transcode.describe(path.join(config.SHOP_DIR, req.file.filename));
        } catch (e) {
          console.error('[shop] 转码计划失败', e);
        }
      }

      res.json({
        url,
        size: req.file.size,
        name: originalName,
        mime: req.file.mimetype,
        playback
      });
    } catch (e) {
      console.error('[shop upload]', e);
      // 到这个分支时 req.file 已经落盘，交给 cleanup_orphan_files 兜底清理；
      // 只回复错误，不要把半成功状态当成 200 返回给前端。
      if (!res.headersSent) res.status(400).json({ error: e.message || '上传失败' });
    }
  });
});

router.post('/shop/cover', authMiddleware, uploadGuard, (req, res) => {
  uploadCover.single('cover')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '封面不能超过 5MB' });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    res.json({ url: `/uploads/covers/${req.file.filename}`, size: req.file.size });
  });
});

// ============================================================
// 上架
// ============================================================
router.get('/shop/catalog', authMiddleware, (req, res) => {
  res.json({
    markets: SHOP_CFG.markets,
    categories: SHOP_CFG.categories || ['goods'],
    price: SHOP_CFG.price,
    title: SHOP_CFG.title,
    files: SHOP_CFG.files,
    descriptionMaxLen: SHOP_CFG.description_max_len
  });
});

// [CHANGED] 上架对所有登录用户开放（跳蚤 / 标准市场）；
// 官方市场仍需 official_publish —— 不能只凭上架权限冒充官方发布。
router.post('/shop/products', authMiddleware, (req, res) => {
  try {
    const { title, description, price, market, coverUrl, files, category } = req.body || {};

    if (!SHOP_CFG.markets.includes(market)) {
      return res.status(400).json({
        error: `market 必须为 ${SHOP_CFG.markets.join(' / ')}`
      });
    }
    // 官方市场是官方自营（商品挂到官方账户名下）：走专用能力位，
    // 不能只凭 list_products（上架权限）就冒充官方发布。
    if (market === 'official' && !can(req.user.role, 'official_publish')) {
      return res.status(403).json({ error: '权限不足：需要 official_publish 能力' });
    }
    const CATEGORIES = SHOP_CFG.categories || ['goods'];
    if (category !== undefined && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category 必须为 ${CATEGORIES.join(' / ')}` });
    }
    if (!title || typeof title !== 'string'
        || title.trim().length < SHOP_CFG.title.min_len
        || title.length > SHOP_CFG.title.max_len) {
      return res.status(400).json({
        error: `标题需为 ${SHOP_CFG.title.min_len}-${SHOP_CFG.title.max_len} 字符`
      });
    }
    if (!Array.isArray(files) || files.length < SHOP_CFG.files.min) {
      return res.status(400).json({ error: `至少上传 ${SHOP_CFG.files.min} 个文件` });
    }
    if (files.length > SHOP_CFG.files.max) {
      return res.status(400).json({ error: `最多 ${SHOP_CFG.files.max} 个文件` });
    }

    const result = createProduct({
      sellerId: req.user.id,
      actorId: req.user.id,
      actorRole: req.user.role,
      title: title.trim(),
      description: (description || '').toString().slice(0, SHOP_CFG.description_max_len),
      price: market === 'standard' ? 0 : Number(price),
      coverUrl: coverUrl || null,
      category: category || 'goods',
      files: files.map((f) => ({
        url: f.url,
        name: f.name,
        type: f.type || null,
        size: Number.isFinite(f.size) ? f.size : null,
        isPreview: !!f.isPreview
      })),
      market
    });

    res.json({
      ok: true,
      id: result.id,
      market: result.market,
      category: result.category,
      status: result.status,
      price: result.price,
      piratedOf: result.piratedOf,
      message: result.message
    });
  } catch (err) {
    console.error('[shop create]', err);
    res.status(400).json({ error: err.message || '上架失败' });
  }
});

// ============================================================
// 列表
// ============================================================
function listMarket(market, keyword, limit, category) {
  const base = `
    SELECT p.id, p.title, p.description, p.price, p.cover_url AS coverUrl,
           p.market, p.category, p.status, p.created_at AS createdAt,
           p.seller_id AS sellerId,
           u.nickname AS sellerName, u.avatar AS sellerAvatar
    FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status = 'on_sale' AND p.market = ?
  `;
  const args = [market];
  let sql = base;
  if (category) {
    sql += ' AND p.category = ?';
    args.push(category);
  }
  if (keyword) {
    sql += ' AND instr(lower(p.title), lower(?)) > 0';
    args.push(keyword);
  }
  sql += ' ORDER BY p.created_at DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args);
}

for (const market of SHOP_CFG.markets) {
  router.get(`/shop/market/${market}`, authMiddleware, (req, res) => {
    const kw = (req.query.keyword || '').toString().trim();
    const category = (req.query.category || '').toString().trim() || null;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    res.json({ products: listMarket(market, kw, limit, category) });
  });
}

router.get('/shop/mine', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT id, title, price, market, category, status, review_mode AS reviewMode,
            cover_url AS coverUrl, pirated_of AS piratedOf,
            delist_reason AS delistReason, created_at AS createdAt
     FROM products WHERE seller_id = ?
     ORDER BY created_at DESC LIMIT 100`
  ).all(req.user.id);
  res.json({ products: rows });
});

// ============================================================
// 详情 / 购买 / 订单
// ============================================================
router.get('/shop/products/:id', authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const data = getProductDetail(id, req.user.id);
  if (!data) return res.status(404).json({ error: '商品不存在' });
  res.json(data);
});

router.post('/shop/products/:id/buy', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = purchaseProduct(id, req.user.id);
    res.json({
      ok: true,
      orderId: result.orderId,
      category: result.category,
      grantedAssets: result.grantedAssets,
      grantedPackId: result.grantedPackId
    });
  } catch (err) {
    res.status(400).json({ error: err.message || '购买失败' });
  }
});

router.get('/shop/orders', authMiddleware, (req, res) => {
  // 带上首个文件的 id / 名称：买家要能直接在「我购买的」里走鉴权下载，
  // 而不是拿到一个指向 /uploads/shop/ 的裸链接（该目录不对外暴露）。
  const rows = db.prepare(
    `SELECT o.id, o.product_id AS productId, o.price, o.created_at AS createdAt,
            p.title, p.market, p.category, p.cover_url AS coverUrl,
            u.nickname AS sellerName,
            (SELECT COUNT(*) FROM product_files pf WHERE pf.product_id = p.id) AS fileCount,
            (SELECT pf.id FROM product_files pf WHERE pf.product_id = p.id
              ORDER BY pf.sort_order, pf.id LIMIT 1) AS fileId,
            (SELECT pf.file_name FROM product_files pf WHERE pf.product_id = p.id
              ORDER BY pf.sort_order, pf.id LIMIT 1) AS fileName
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN users u ON u.id = o.seller_id
     WHERE o.buyer_id = ? AND o.status = 'paid'
     ORDER BY o.created_at DESC LIMIT 100`
  ).all(req.user.id);
  res.json({ orders: rows });
});

module.exports = router;