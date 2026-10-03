// src/routes/fileTypes.js
//
// 文件类型表（供前端渲染文件卡片图标 / 封面）。
//
//   GET /api/file-types  →  { types: [{ key, label, color, exts, cover }] }
//
// 只下发**开发者新增/覆盖**的类型；内置的 11 类硬编码在前端
// `client/src/utils/fileTypes.js`，前端把两者合并（自定义优先）。
//
// 为什么走接口而不是塞进前端构建产物：开发者改完 config.yaml 重启后端即可生效，
// 不用重新 `npm run build` 前端。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const config = require('../config');

const router = express.Router();

router.get('/file-types', authMiddleware, (req, res) => {
  res.json({ types: config.FILE_TYPES });
});

module.exports = router;
