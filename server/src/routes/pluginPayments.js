// src/routes/pluginPayments.js
//
// 插件支付的 HTTP 接口。
//
// 桥调用（`hostAPI.call('payment.request', ...)`）最终会打到
// `POST /api/plugins/payments`。宿主在弹完确认框、用户点"确认"之后才调这里。
//
// [SEC] 服务端不看"是插件在调还是宿主在调" —— 都当作普通用户发起的请求，
//   只按当前登录用户身份走权限、限流、事务。这正是为什么确认框必须在
//   宿主侧：只有那里才有"用户刚刚点过确认"这个信号。
//
const express = require('express');
const { authMiddleware } = require('../auth');
const pay = require('../services/pluginPayments');
const pluginsSvc = require('../services/plugins');

const router = express.Router();

function send(res, err) {
  res.status(err.status || 400).json({ error: err.message || '操作失败' });
}

// ============================================================
// 支付前查询：宿主 UI 用它渲染确认框
//   GET /api/plugins/:id/pay-info?amount=100
// ============================================================
router.get('/plugins/:id/pay-info', authMiddleware, (req, res) => {
  try {
    const amount = req.query.amount !== undefined ? Number(req.query.amount) : null;
    res.json(pay.payInfo(req.user.id, String(req.params.id), amount));
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 发起支付（宿主确认框"确认"后调用）
//   POST /api/plugins/payments
//   { pluginId, amount, subject, orderId, metadata? }
//
// 路由层做两件事：
//   1) 用户是否安装了这个插件（未安装不能付钱）
//   2) 用户是否**在安装时**批准了 payment:request 权限
//      —— 作者本人豁免（调试自己的插件）
// ============================================================
router.post('/plugins/payments', authMiddleware, (req, res) => {
  try {
    const { pluginId, amount, subject, orderId, metadata } = req.body || {};
    const pid = String(pluginId || '').trim();
    if (!pid) throw Object.assign(new Error('缺少 pluginId'), { status: 400 });

    const plugin = pluginsSvc.getById(pid, req.user.id);
    if (!plugin) throw Object.assign(new Error('插件不存在'), { status: 404 });

    const isOwner = plugin.ownerId === req.user.id;
    const installed = !!plugin.installed;
    if (!installed && !isOwner) {
      throw Object.assign(new Error('未安装该插件'), { status: 403 });
    }

    // 权限检查：非作者必须已批准 payment:request
    if (!isOwner) {
      const set = pluginsSvc.grantedPermSet(req.user.id, pid);
      if (!set.has('payment:request')) {
        throw Object.assign(new Error('缺少权限：payment:request'), { status: 403 });
      }
    }

    // 限流
    pay.checkRateLimit(req.user.id);

    const out = pay.pay(req.user.id, pid, {
      amount: Number(amount),
      subject,
      orderId,
      metadata
    });
    res.json(out);
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 我的支付记录（买家视角）
// ============================================================
router.get('/plugins/payments/mine', authMiddleware, (req, res) => {
  try {
    res.json({ payments: pay.listByBuyer(req.user.id, req.query.limit) });
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 我的收款记录（卖家视角）
// ============================================================
router.get('/plugins/payments/seller', authMiddleware, (req, res) => {
  try {
    res.json({ payments: pay.listBySeller(req.user.id, req.query.limit) });
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 单笔详情（买家、卖家、管理员可见）
// ============================================================
router.get('/plugins/payments/:id', authMiddleware, (req, res) => {
  try {
    const p = pay.getById(req.params.id);
    if (!p) return res.status(404).json({ error: '支付记录不存在' });
    const isBuyer = p.buyerId === req.user.id;
    const isSeller = p.sellerId === req.user.id;
    const isAdminUser = ['developer', 'super_admin', 'admin'].includes(req.user.role);
    if (!isBuyer && !isSeller && !isAdminUser) {
      return res.status(403).json({ error: '无权查看' });
    }
    res.json({ payment: p });
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 自助退款（买家，窗口期内）
// ============================================================
router.post('/plugins/payments/:id/refund', authMiddleware, (req, res) => {
  try {
    const reason = String(req.body?.reason || '').slice(0, 200);
    const out = pay.refund(req.params.id, req.user.id, req.user.role, reason);
    res.json(out);
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 管理员：全量列表
// ============================================================
router.get('/admin/plugins/payments', authMiddleware, (req, res) => {
  try {
    if (!['developer', 'super_admin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    res.json({
      payments: pay.listAll({
        limit: req.query.limit,
        pluginId: req.query.pluginId || null,
        status: req.query.status || null
      })
    });
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 管理员：强制退款（不受窗口限制）
// ============================================================
router.post('/admin/plugins/payments/:id/refund', authMiddleware, (req, res) => {
  try {
    if (!['developer', 'super_admin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const reason = String(req.body?.reason || '管理员退款').slice(0, 200);
    const out = pay.refund(req.params.id, req.user.id, req.user.role, reason);
    res.json(out);
  } catch (err) {
    send(res, err);
  }
});

// ============================================================
// 单插件的支付统计（作者看自己的插件营收）
// ============================================================
router.get('/plugins/:id/pay-stats', authMiddleware, (req, res) => {
  try {
    const plugin = pluginsSvc.getById(String(req.params.id), req.user.id);
    if (!plugin) return res.status(404).json({ error: '插件不存在' });
    const isOwner = plugin.ownerId === req.user.id;
    const isAdminUser = ['developer', 'super_admin', 'admin'].includes(req.user.role);
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ error: '只有作者或管理员可以查看营收' });
    }
    res.json(pay.statsForPlugin(String(req.params.id)));
  } catch (err) {
    send(res, err);
  }
});

module.exports = router;