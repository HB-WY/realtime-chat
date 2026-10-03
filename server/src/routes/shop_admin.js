// src/routes/shop_admin.js
//
// 【本次改动】pending-review 的 N+1 消除：
//   原先对每行单独 COUNT(*) 查 fileCount（100 行 = 100 次查询）。
//   改成 LEFT JOIN + GROUP BY 一次拿全。
//
const express = require('express');
const { db, OFFICIAL_USER_ID } = require('../db');
const { authMiddleware } = require('../auth');
const { can, canOperate, audit } = require('../services/permissions');
const { reviewOfficialPrice, delistProduct } = require('../services/products');

const router = express.Router();

function requireCap(capability) {
  return (req, res, next) => {
    if (!can(req.user.role, capability)) return res.status(403).json({ error: '权限不足' });
    next();
  };
}

// ============================================================
// 待审核列表（JOIN 一次拿全，消除 N+1）
// ============================================================
router.get('/admin/shop/pending-review', authMiddleware, requireCap('review_price'), (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.title, p.description, p.cover_url AS coverUrl, p.category,
            p.created_at AS createdAt, u.nickname AS sellerName, u.avatar AS sellerAvatar,
            COUNT(pf.id) AS fileCount
     FROM products p
     JOIN users u ON u.id = p.seller_id
     LEFT JOIN product_files pf ON pf.product_id = p.id
     WHERE p.market = 'standard' AND p.status = 'pending_review'
     GROUP BY p.id
     ORDER BY p.created_at ASC LIMIT 100`
  ).all();
  res.json({ products: rows });
});

router.post('/admin/shop/review/:id', authMiddleware, requireCap('review_price'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const price = Number(req.body?.price);
    const note = (req.body?.note || '').toString().slice(0, 500);
    reviewOfficialPrice(id, req.user.id, req.user.role, price, note);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '审核失败' });
  }
});

router.post('/admin/shop/delist/:id', authMiddleware, requireCap('delist_product'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const reason = (req.body?.reason || '').toString().slice(0, 500);
    delistProduct(id, req.user.id, req.user.role, reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '下架失败' });
  }
});

router.post('/admin/shop/hide/:id', authMiddleware, requireCap('hide_product'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const reason = (req.body?.reason || '').toString().slice(0, 500);
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(404).json({ error: '商品不存在' });
    if (!['on_sale', 'hidden', 'pirated'].includes(prod.status)) {
      return res.status(400).json({ error: '当前状态不允许隐藏' });
    }
    db.prepare(`UPDATE products SET status = 'hidden', delist_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason || '待审核', Date.now(), id);
    audit(req.user.id, req.user.role, 'hide', 'product', id, reason || null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[hide]', err);
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/admin/shop/unhide/:id', authMiddleware, requireCap('hide_product'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(404).json({ error: '商品不存在' });
    if (prod.status !== 'hidden') return res.status(400).json({ error: '商品未被隐藏' });
    db.prepare(`UPDATE products SET status = 'on_sale', delist_reason = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    audit(req.user.id, req.user.role, 'unhide', 'product', id, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[unhide]', err);
    res.status(500).json({ error: '操作失败' });
  }
});

router.get('/admin/users', authMiddleware, requireCap('view_audit'), (req, res) => {
  const kw = (req.query.keyword || '').toString().trim();
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  let rows;
  if (kw) {
    rows = db.prepare(
      `SELECT id, username, nickname, avatar, role, status, created_at AS createdAt
       FROM users WHERE instr(username, ?) > 0 OR instr(nickname, ?) > 0
       ORDER BY created_at DESC LIMIT ?`
    ).all(kw, kw, limit);
  } else {
    rows = db.prepare(
      `SELECT id, username, nickname, avatar, role, status, created_at AS createdAt
       FROM users ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
  }
  res.json({ users: rows });
});

router.post('/admin/users/:id/status', authMiddleware, (req, res) => {
  try {
    const actorRole = req.user.role;
    const targetId = Number(req.params.id);
    const { status, reason } = req.body || {};

    if (!['active', 'disabled', 'banned'].includes(status)) {
      return res.status(400).json({ error: 'status 非法' });
    }
    if (targetId === req.user.id) return res.status(400).json({ error: '不能操作自己' });
    if (targetId === OFFICIAL_USER_ID) return res.status(403).json({ error: '官方系统账户不可操作' });

    const cap = status === 'banned' ? 'ban_user' : 'disable_user';
    if (!can(actorRole, cap)) return res.status(403).json({ error: '权限不足' });

    const target = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (!canOperate(actorRole, target.role)) {
      return res.status(403).json({ error: '不能操作同级或更高级用户' });
    }

    db.prepare(
      `UPDATE users SET status = ?, banned_at = ?, banned_by = ?, ban_reason = ? WHERE id = ?`
    ).run(
      status,
      status === 'active' ? null : Date.now(),
      status === 'active' ? null : req.user.id,
      status === 'active' ? null : (reason || '').toString().slice(0, 200),
      targetId
    );

    audit(req.user.id, actorRole,
      status === 'active' ? 'unban' : (status === 'banned' ? 'ban' : 'disable'),
      'user', targetId, reason || null);

    if (status !== 'active') {
      db.prepare(
        'UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL'
      ).run(Date.now(), req.user.id, targetId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin status]', err);
    res.status(500).json({ error: '操作失败' });
  }
});

router.get('/admin/audit', authMiddleware, requireCap('view_audit'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare(
    `SELECT a.id, a.actor_id AS actorId, a.actor_role AS actorRole, a.action,
            a.target_type AS targetType, a.target_id AS targetId, a.detail,
            a.created_at AS createdAt, u.nickname AS actorName
     FROM admin_audit a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC LIMIT ?`
  ).all(limit);
  res.json({ logs: rows });
});

module.exports = router;