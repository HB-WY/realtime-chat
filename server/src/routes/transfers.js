// src/routes/transfers.js
//
// 转账 HTTP 接口。与 socket 共用 services/transfers.js，两条通道行为一致。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const transfers = require('../services/transfers');

const router = express.Router();

function send(res, err) {
  res.status(err.status || 400).json({ error: err.message || '操作失败' });
}

// 发起转账
router.post('/transfers', authMiddleware, (req, res) => {
  try {
    const { toUserId, amount, note } = req.body || {};
    const out = transfers.create(req.user, {
      toUserId: Number(toUserId),
      amount: Number(amount),
      note
    });
    res.status(201).json({ ok: true, ...out });
  } catch (err) {
    send(res, err);
  }
});

// 收款
router.post('/transfers/:id/accept', authMiddleware, (req, res) => {
  try {
    const out = transfers.accept(req.user.id, req.params.id);
    res.json({ ok: true, ...out });
  } catch (err) {
    send(res, err);
  }
});

// 退还
router.post('/transfers/:id/reject', authMiddleware, (req, res) => {
  try {
    const out = transfers.reject(req.user.id, req.params.id);
    res.json({ ok: true, ...out });
  } catch (err) {
    send(res, err);
  }
});

// 单条详情
router.get('/transfers/:id', authMiddleware, (req, res) => {
  const t = transfers.getById(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: '转账不存在或无权查看' });
  res.json({ transfer: t });
});

// 我的转账记录
router.get('/transfers/mine', authMiddleware, (req, res) => {
  const role = String(req.query.role || 'all');
  res.json({ transfers: transfers.listMine(req.user.id, role, req.query.limit) });
});

module.exports = router;
