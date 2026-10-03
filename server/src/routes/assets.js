// src/routes/assets.js
//
// 统一资源池：图片上传（PNG / JPG / GIF / WebP 等，单次批量合计 ≤500MB，
// 总量配额默认不限制，sha256 去重，落盘 uploads/custom/{userId}/）。
const express = require('express');
const config = require('../config');
const { authMiddleware } = require('../auth');
const { uploadAssets } = require('../middleware/upload');
const uploadGuard = require('../middleware/uploadGuard');
const assets = require('../services/assets');

const router = express.Router();

function multerError(res, err) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(config.ASSET_MAX / 1048576);
    return res.status(400).json({ error: `单文件不能超过 ${mb}MB` });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: '单次上传文件数量超出上限' });
  }
  return res.status(400).json({ error: err?.message || '上传失败' });
}

// ============================================================
// 上传（单文件字段 file，或多文件字段 files）
// ============================================================
router.post('/assets/upload', authMiddleware, uploadGuard, (req, res) => {
  const mw = uploadAssets.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 50 }
  ]);
  mw(req, res, (err) => {
    if (err) return multerError(res, err);
    try {
      const list = [...(req.files?.file || []), ...(req.files?.files || [])];
      const kind = assets.KINDS.includes(req.body?.kind) ? req.body.kind : 'image';
      const out = assets.ingestUploads(req.user.id, list, { kind, source: 'upload' });
      res.json({
        ok: true,
        asset: out.created[0] || out.deduped[0] || null,
        assets: out.assets,
        created: out.created.length,
        deduped: out.deduped.length,
        usage: assets.usage(req.user.id)
      });
    } catch (e) {
      res.status(400).json({ error: e.message || '上传失败' });
    }
  });
});

// ============================================================
// 列表 / 配额 / 详情 / 删除
// ============================================================
router.get('/assets', authMiddleware, (req, res) => {
  const kind = req.query.kind ? req.query.kind.toString() : null;
  if (kind && !assets.KINDS.includes(kind)) {
    return res.status(400).json({ error: '未知的资源类型' });
  }
  res.json({
    assets: assets.listAssets(req.user.id, { kind, limit: req.query.limit }),
    usage: assets.usage(req.user.id)
  });
});

router.get('/assets/quota', authMiddleware, (req, res) => {
  res.json(assets.usage(req.user.id));
});

router.get('/assets/:id', authMiddleware, (req, res) => {
  const a = assets.getAsset(req.user.id, Number(req.params.id));
  if (!a) return res.status(404).json({ error: '资源不存在' });
  res.json({ asset: a });
});

router.delete('/assets/:id', authMiddleware, (req, res) => {
  try {
    assets.deleteAsset(req.user.id, Number(req.params.id));
    res.json({ ok: true, usage: assets.usage(req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除失败' });
  }
});

module.exports = router;
