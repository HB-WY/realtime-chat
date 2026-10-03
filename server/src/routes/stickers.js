// src/routes/stickers.js
//
// 表情包：创建 / 批量上传 / 排序 / 公开分享码 / 订阅（不复制文件）
//
// 【本次新增】GET /api/stickers/lookup?url= —— 聊天界面右键表情消息时，
//   反查该表情属于哪个表情包、调用者是否拥有 / 订阅，用来决定菜单项。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const { uploadAssets } = require('../middleware/upload');
const stickers = require('../services/stickers');

const router = express.Router();

// ============================================================
// 反查
// ============================================================
router.get('/stickers/lookup', authMiddleware, (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  res.json({ info: stickers.lookupByUrl(req.user.id, url) });
});

// ============================================================
// 表情包 CRUD
// ============================================================
router.get('/stickers/packs', authMiddleware, (req, res) => {
  res.json({ packs: stickers.listPacks(req.user.id) });
});

router.post('/stickers/packs', authMiddleware, (req, res) => {
  try {
    const pack = stickers.createPack(req.user.id, req.body || {});
    res.status(201).json({ ok: true, pack });
  } catch (err) {
    res.status(400).json({ error: err.message || '创建失败' });
  }
});

router.get('/stickers/packs/:id', authMiddleware, (req, res) => {
  try {
    res.json(stickers.getPack(req.user.id, Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message || '表情包不存在' });
  }
});

router.patch('/stickers/packs/:id', authMiddleware, (req, res) => {
  try {
    const pack = stickers.updatePack(req.user.id, Number(req.params.id), req.body || {});
    res.json({ ok: true, pack });
  } catch (err) {
    res.status(400).json({ error: err.message || '修改失败' });
  }
});

router.delete('/stickers/packs/:id', authMiddleware, (req, res) => {
  try {
    stickers.deletePack(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除失败' });
  }
});

// ============================================================
// 表情项（批量上传）
// ============================================================
router.post('/stickers/packs/:id/items', authMiddleware, (req, res) => {
  const mw = uploadAssets.fields([{ name: 'files', maxCount: 50 }, { name: 'file', maxCount: 1 }]);
  mw(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '单张表情不能超过 10MB' });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    try {
      const files = [...(req.files?.files || []), ...(req.files?.file || [])];
      if (files.length === 0) return res.status(400).json({ error: '未收到文件' });
      const out = stickers.addItems(req.user.id, Number(req.params.id), files);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(400).json({ error: e.message || '上传失败' });
    }
  });
});

router.put('/stickers/packs/:id/items/order', authMiddleware, (req, res) => {
  try {
    const items = stickers.reorderItems(
      req.user.id, Number(req.params.id), req.body?.order || req.body?.ids
    );
    res.json({ ok: true, items });
  } catch (err) {
    res.status(400).json({ error: err.message || '排序失败' });
  }
});

router.delete('/stickers/packs/:id/items/:itemId', authMiddleware, (req, res) => {
  try {
    stickers.removeItem(req.user.id, Number(req.params.id), Number(req.params.itemId));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除失败' });
  }
});

// ============================================================
// 分享 / 订阅
// ============================================================
router.post('/stickers/packs/:id/share', authMiddleware, (req, res) => {
  try {
    const out = stickers.sharePack(
      req.user.id, Number(req.params.id), !!req.body?.regenerate
    );
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message || '分享失败' });
  }
});

router.post('/stickers/packs/:id/private', authMiddleware, (req, res) => {
  try {
    const pack = stickers.setPrivate(req.user.id, Number(req.params.id));
    res.json({ ok: true, pack });
  } catch (err) {
    res.status(400).json({ error: err.message || '操作失败' });
  }
});

router.post('/stickers/subscribe', authMiddleware, (req, res) => {
  try {
    const pack = stickers.subscribe(req.user.id, req.body?.code ?? req.body?.shareCode);
    res.json({ ok: true, pack });
  } catch (err) {
    res.status(400).json({ error: err.message || '订阅失败' });
  }
});

router.delete('/stickers/subscribe/:packId', authMiddleware, (req, res) => {
  try {
    res.json({ ok: true, ...stickers.unsubscribe(req.user.id, Number(req.params.packId)) });
  } catch (err) {
    res.status(400).json({ error: err.message || '取消订阅失败' });
  }
});

module.exports = router;