// src/routes/apikeys.js
//
// API 密钥管理：
//   POST   /keys                  申请密钥（明文只返回一次）
//   GET    /keys                  列表（只显示 12 位前缀 + 最近使用时间）
//   POST   /keys/:id/revoke       撤销
//   DELETE /keys/:id              撤销（同义）
//   GET    /admin/apikeys/ip-claims                管理员：查看 IP 绑定
//   POST   /admin/apikeys/ip-claims/release        管理员：手动释放 IP 绑定
//
const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../auth');
const { can, audit } = require('../services/permissions');
const apikey = require('../auth/apikey');
const { clientIp } = require('../utils/ip');
const config = require('../config');

const CFG = config.APIKEY_CFG;
const router = express.Router();

function keyDto(row) {
  return {
    id: row.id,
    name: row.name || '',
    prefix: row.prefix,
    masked: apikey.maskKey(row.prefix),
    // [SEC] boundIp 是**强制生效**的绑定值（此前只记录不校验）
    boundIp: row.bound_ip || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    lastIp: row.last_ip || null,
    revokedAt: row.revoked_at || null,
    status: row.revoked_at ? 'revoked' : 'active'
  };
}

// ============================================================
// 申请
// ============================================================
router.post('/keys', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const name = (req.body?.name ?? '').toString().trim().slice(0, 50);

    const active = db.prepare(
      'SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL'
    ).get(userId).c;
    if (active >= (CFG.max_per_user || 10)) {
      return res.status(400).json({ error: `最多同时持有 ${CFG.max_per_user} 个有效密钥` });
    }

    const ip = clientIp(req);

    // 同一 IP 只能绑定一个用户（撤销密钥不释放绑定）
    const claim = apikey.claimIp(ip, userId, `申请密钥 ${name || '(未命名)'}`);
    if (!claim.ok) {
      return res.status(403).json({ error: claim.error });
    }

    const { plain, prefix, hash } = apikey.generateKey();
    const now = Date.now();
    // [SEC] 同时记下申请时的来源 IP：此后**每一次**使用都会强制比对
    //       （见 auth/apikey.js），不是只写进响应给自己看。
    const info = db.prepare(
      `INSERT INTO api_keys (user_id, name, key_hash, prefix, bound_ip, created_at, last_used_at, last_ip)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(userId, name, hash, prefix, ip, now);

    // [SEC] 明文只在这里出现一次，之后库里只有哈希
    res.status(201).json({
      ok: true,
      key: plain,
      prefix,
      masked: apikey.maskKey(prefix),
      id: Number(info.lastInsertRowid),
      name,
      createdAt: now,
      boundIp: ip,
      notice:
        '请立即保存：明文密钥只显示这一次，服务端只保存 SHA-256 哈希。' +
        `该密钥已绑定来源 IP ${ip}，从其他 IP 使用会被拒绝。`
    });
  } catch (err) {
    console.error('[apikey create]', err);
    res.status(400).json({ error: err.message || '申请失败' });
  }
});

// ============================================================
// 列表
// ============================================================
router.get('/keys', authMiddleware, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(req.user.id);
  res.json({
    keys: rows.map(keyDto),
    max: CFG.max_per_user || 10
  });
});

// ============================================================
// 撤销
// ============================================================
function revoke(req, res) {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?')
      .get(id, req.user.id);
    if (!row) return res.status(404).json({ error: '密钥不存在' });
    if (row.revoked_at) return res.json({ ok: true, alreadyRevoked: true });

    // [SEC] 撤销只标记密钥；IP 绑定按设计保留，需要管理员手动释放
    db.prepare('UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?')
      .run(Date.now(), req.user.id, id);

    res.json({ ok: true, ipBindingKept: true });
  } catch (err) {
    console.error('[apikey revoke]', err);
    res.status(500).json({ error: '撤销失败' });
  }
}

router.post('/keys/:id/revoke', authMiddleware, revoke);
router.delete('/keys/:id', authMiddleware, revoke);

// ============================================================
// 管理员：IP 绑定
// ============================================================
function requireCap(capability) {
  return (req, res, next) => {
    if (!can(req.user.role, capability)) return res.status(403).json({ error: '权限不足' });
    next();
  };
}

router.get('/admin/apikeys/ip-claims', authMiddleware, requireCap('manage_apikeys'), (req, res) => {
  const onlyActive = req.query.all !== '1';
  res.json({ claims: apikey.listIpClaims({ onlyActive, limit: req.query.limit }) });
});

router.post('/admin/apikeys/ip-claims/release', authMiddleware, requireCap('manage_apikeys'), (req, res) => {
  try {
    const { ip, userId } = req.body || {};
    let targetIp = ip ? ip.toString().trim() : null;

    if (!targetIp && userId) {
      const row = db.prepare(
        'SELECT ip FROM apikey_ip_claims WHERE user_id = ? AND released_at IS NULL ORDER BY updated_at DESC LIMIT 1'
      ).get(Number(userId));
      if (!row) return res.status(404).json({ error: '该用户没有生效中的 IP 绑定' });
      targetIp = row.ip;
    }
    if (!targetIp) return res.status(400).json({ error: '需要提供 ip 或 userId' });

    const out = apikey.releaseIp(targetIp, req.user.id, (req.body?.note || '').toString().slice(0, 200));
    if (!out.ok) return res.status(400).json({ error: out.error });

    audit(req.user.id, req.user.role, 'release_ip_binding', 'apikey_ip', 0, targetIp);
    res.json({ ok: true, ip: targetIp });
  } catch (err) {
    console.error('[apikey release ip]', err);
    res.status(500).json({ error: '释放失败' });
  }
});

// 当前密钥自检：确认密钥通道是否可用
router.get('/keys/whoami', authMiddleware, (req, res) => {
  res.json({
    user: req.user,
    authType: req.authType || 'jwt',
    keyPrefix: req.apiKey?.prefix || null,
    ip: req.clientIp || clientIp(req)
  });
});

module.exports = router;
