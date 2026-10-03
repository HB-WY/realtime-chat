// src/routes/roles.js
const express = require('express');
const { db } = require('../db');
const { transaction } = require('../db/tx');
const { authMiddleware } = require('../auth');
const {
  ROLES, REQUESTABLE_ROLES,
  isDeveloper, isInPromotionCooldown, cooldownRemainingMs, audit
} = require('../services/permissions');

const router = express.Router();

router.post('/roles/request', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const { toRole, reason } = req.body || {};

    if (!REQUESTABLE_ROLES.includes(toRole)) {
      return res.status(400).json({ error: '只能申请 super_admin 或 developer' });
    }
    if (toRole === 'developer' && req.user.role === 'developer') {
      return res.status(400).json({ error: '你已经是开发者' });
    }
    if (toRole === 'super_admin' && req.user.role === 'super_admin') {
      return res.status(400).json({ error: '你已经是超级管理员' });
    }

    if (isInPromotionCooldown(userId)) {
      const ms = cooldownRemainingMs(userId);
      const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
      return res.status(429).json({ error: `距上次升职不足 7 天，还需等待约 ${days} 天`, remainingMs: ms });
    }

    const pending = db.prepare(
      `SELECT id FROM role_requests WHERE user_id = ? AND status = 'pending'`
    ).get(userId);
    if (pending) return res.status(409).json({ error: '已有待审批的申请' });

    const info = db.prepare(
      `INSERT INTO role_requests (user_id, from_role, to_role, status, reason, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ).run(userId, req.user.role, toRole, (reason || '').toString().slice(0, 1000), Date.now());

    res.json({ ok: true, requestId: Number(info.lastInsertRowid) });
  } catch (err) {
    console.error('[role request]', err);
    res.status(500).json({ error: '提交失败' });
  }
});

router.get('/roles/my-requests', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT id, from_role AS fromRole, to_role AS toRole, status, reason,
            review_note AS reviewNote, created_at AS createdAt, reviewed_at AS reviewedAt
     FROM role_requests WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 20`
  ).all(req.user.id);
  res.json({ requests: rows, cooldownRemainingMs: cooldownRemainingMs(req.user.id) });
});

router.get('/roles/pending', authMiddleware, (req, res) => {
  if (!isDeveloper(req.user.role)) return res.status(403).json({ error: '只有开发者可以查看' });
  const rows = db.prepare(
    `SELECT r.id, r.user_id AS userId, r.from_role AS fromRole, r.to_role AS toRole,
            r.reason, r.created_at AS createdAt,
            u.username, u.nickname, u.avatar
     FROM role_requests r JOIN users u ON u.id = r.user_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at ASC LIMIT 100`
  ).all();
  res.json({ requests: rows });
});

router.post('/roles/review/:id', authMiddleware, (req, res) => {
  try {
    if (!isDeveloper(req.user.role)) return res.status(403).json({ error: '只有开发者可以审批' });

    const id = Number(req.params.id);
    const { approve, note } = req.body || {};
    if (typeof approve !== 'boolean') return res.status(400).json({ error: 'approve 必须为布尔值' });

    const request = db.prepare('SELECT * FROM role_requests WHERE id = ?').get(id);
    if (!request) return res.status(404).json({ error: '申请不存在' });
    if (request.status !== 'pending') return res.status(400).json({ error: '申请已处理' });

    const now = Date.now();

    if (!approve) {
      db.prepare(
        `UPDATE role_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?,
                                   review_note = ? WHERE id = ?`
      ).run(req.user.id, now, (note || '').toString().slice(0, 500), id);

      audit(req.user.id, req.user.role, 'reject_promotion', 'user', request.user_id,
            `拒绝 ${request.from_role} → ${request.to_role}${note ? '：' + note : ''}`);

      return res.json({ ok: true, status: 'rejected' });
    }

    if (!ROLES[request.to_role]) return res.status(400).json({ error: '目标角色非法' });

    // 用新 transaction（返回一个函数，需要 () 立即调用）
    transaction(() => {
      db.prepare(
        `UPDATE role_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?,
                                   review_note = ? WHERE id = ?`
      ).run(req.user.id, now, (note || '').toString().slice(0, 500), id);

      db.prepare(`UPDATE users SET role = ?, last_promoted_at = ? WHERE id = ?`)
        .run(request.to_role, now, request.user_id);
    })();

    audit(req.user.id, req.user.role, 'approve_promotion', 'user', request.user_id,
          `${request.from_role} → ${request.to_role}${note ? '：' + note : ''}`);

    res.json({ ok: true, status: 'approved', newRole: request.to_role });
  } catch (err) {
    console.error('[role review]', err);
    res.status(500).json({ error: '审批失败' });
  }
});

router.post('/roles/grant/:userId', authMiddleware, (req, res) => {
  try {
    const actorRole = req.user.role;
    const targetId = Number(req.params.userId);
    const { role: newRole } = req.body || {};

    if (!['admin', 'user'].includes(newRole)) {
      return res.status(400).json({ error: '只能直接分发 admin 或 user' });
    }
    if (targetId === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });
    if (actorRole !== 'developer' && actorRole !== 'super_admin') {
      return res.status(403).json({ error: '只有开发者或超级管理员可以分发' });
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'developer') return res.status(403).json({ error: '不能操作开发者' });
    if (target.role === 'super_admin' && actorRole !== 'developer') {
      return res.status(403).json({ error: '不能操作超级管理员' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, targetId);

    audit(req.user.id, actorRole,
      newRole === 'admin' ? 'grant_admin' : 'revoke_admin',
      'user', targetId, `${target.role} → ${newRole}（直接分发）`);

    res.json({ ok: true, from: target.role, to: newRole });
  } catch (err) {
    console.error('[role grant]', err);
    res.status(500).json({ error: '分发失败' });
  }
});

module.exports = router;