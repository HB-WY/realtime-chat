// src/routes/rooms.js
//
// 房间设置 REST（同时挂在 /api 与 /api/v1 下，脚本带密钥即可调用）。
// 目前只有「公共聊天」的图标；更换图标需要 manage_public_room 能力（默认仅开发者）。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const rooms = require('../services/rooms');

const router = express.Router();

router.get('/rooms/public', authMiddleware, (req, res) => {
  res.json(rooms.getPublicRoom());
});

router.put('/rooms/public/icon', authMiddleware, (req, res) => {
  try {
    res.json({ ok: true, room: rooms.setPublicRoomIcon(req.user, req.body?.icon) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || '设置失败' });
  }
});

module.exports = router;
