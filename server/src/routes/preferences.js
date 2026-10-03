// src/routes/preferences.js
//
// 个性化偏好：GET /api/preferences（同时可用于 /api/v1）
// 结构：
// {
//   global: { background, bubble, fontSize, updatedAt },
//   rooms:  { "<roomKey>": { roomKey, background, updatedAt } },
//   limits: { fontMin, fontMax, maxRooms, ... }
// }
const express = require('express');
const { authMiddleware } = require('../auth');
const prefs = require('../services/preferences');

const router = express.Router();

router.get('/preferences', authMiddleware, (req, res) => {
  res.json(prefs.getPreferences(req.user.id));
});

router.put('/preferences', authMiddleware, (req, res) => {
  try {
    const body = req.body || {};
    res.json(prefs.setPreferences(req.user.id, body));
  } catch (err) {
    res.status(400).json({ error: err.message || '保存失败' });
  }
});

// 兼容只改单房间的调用方式
router.put('/preferences/room/:roomKey', authMiddleware, (req, res) => {
  try {
    const out = prefs.setPreferences(req.user.id, {
      room: { roomKey: req.params.roomKey, background: req.body?.background }
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message || '保存失败' });
  }
});

router.delete('/preferences/room/:roomKey', authMiddleware, (req, res) => {
  try {
    res.json(prefs.deleteRoomPreference(req.user.id, req.params.roomKey));
  } catch (err) {
    res.status(400).json({ error: err.message || '清除失败' });
  }
});

module.exports = router;
