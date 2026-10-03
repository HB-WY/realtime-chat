// src/routes/redpackets.js
//
// 红包 HTTP 接口。与 socket 共用 services/redpackets.js。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const redpackets = require('../services/redpackets');

const router = express.Router();

function send(res, err) {
  res.status(err.status || 400).json({ error: err.message || '操作失败' });
}

// 发红包
router.post('/redpackets', authMiddleware, (req, res) => {
  try {
    const { roomType, roomId, totalAmount, count, mode, note } = req.body || {};
    const out = redpackets.create(req.user, {
      roomType: String(roomType || ''),
      roomId: String(roomId || ''),
      totalAmount: Number(totalAmount),
      count: Number(count),
      mode: mode || 'lucky',
      note
    });
    res.status(201).json({ ok: true, ...out });
  } catch (err) {
    send(res, err);
  }
});

// 抢红包
router.post('/redpackets/:id/grab', authMiddleware, (req, res) => {
  try {
    const out = redpackets.grab(req.user.id, req.params.id);
    res.json({ ok: true, ...out });
  } catch (err) {
    send(res, err);
  }
});

// 红包详情（谁抢了多少）
router.get('/redpackets/:id', authMiddleware, (req, res) => {
  const r = redpackets.getById(req.user.id, req.params.id);
  if (!r) return res.status(404).json({ error: '红包不存在或无权查看' });
  res.json({ redPacket: r });
});

// 我的红包记录
router.get('/redpackets/mine', authMiddleware, (req, res) => {
  const role = String(req.query.role || 'all');
  res.json({ redPackets: redpackets.listMine(req.user.id, role, req.query.limit) });
});

module.exports = router;
