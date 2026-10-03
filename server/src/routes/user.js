// src/routes/user.js
//
// 【本次改动】/avatar 的错误文案从 config 现算：
//   原先硬编码「头像不能超过 5MB」，而配置是 8MB —— 加白名单 / 改上限时
//   必然忘改文案。这里直接读 config.AVATAR_MAX 折算 MB。
//
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const config = require('../config');
const { authMiddleware } = require('../auth');
const { sanitizeAvatar } = require('../utils/avatar');
const { pickOriginalName } = require('../utils/filename');
const { uploadAvatar, uploadFile } = require('../middleware/upload');
const uploadGuard = require('../middleware/uploadGuard');
const transcode = require('../services/transcode');

const U = require('../config').BUSINESS.user;

const router = express.Router();

// ============================================================
// [SEC] 头像文件的物理根目录（绝对路径）。
//   用途：PATCH /me 删除旧头像前，用它验证目标确实落在 uploads/avatars/ 内。
//   这里必须用 path.resolve 展开 —— path.join 会规范化 `..`，但 `..` 逃出去
//   之后仍然会通过简单的 startsWith('/uploads/avatars/') 检查（老代码正是
//   这样被绕过的）。
// ============================================================
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const AVATARS_DIR = path.resolve(path.join(SERVER_ROOT, 'uploads', 'avatars'));

function isInsideAvatars(absPath) {
  const abs = path.resolve(absPath);
  if (abs === AVATARS_DIR) return true;
  return abs.startsWith(AVATARS_DIR + path.sep);
}

// ============================================================
// 更新资料
// ============================================================
router.patch('/me', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return res.status(404).json({ error: '用户不存在' });

  const updates = {};
  if (typeof req.body?.nickname === 'string') {
    const n = req.body.nickname.trim();
    if (n.length < U.nickname.min_len || n.length > U.nickname.max_len) {
      return res.status(400).json({
        error: `昵称长度需为 ${U.nickname.min_len}-${U.nickname.max_len} 个字符`
      });
    }
    updates.nickname = n;
  }
  if (typeof req.body?.avatar === 'string') {
    updates.avatar = sanitizeAvatar(req.body.avatar);
  }
  // 【新增】个性签名：可为空字符串（清除签名），上限走 config
  if (typeof req.body?.signature === 'string') {
    const sig = req.body.signature.trim();
    const maxLen = Number(U.signature?.max_len) || 60;
    if (sig.length > maxLen) {
      return res.status(400).json({ error: `签名不能超过 ${maxLen} 个字符` });
    }
    updates.signature = sig;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: '没有需要更新的内容' });
  }

  const fields = Object.keys(updates);
  db.prepare(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map((f) => updates[f]), userId);

  if (updates.avatar !== undefined) {
    // [SEC] 删旧头像文件前的二次校验（纵深防御）：
    //   即使 sanitizeAvatar 已经拒绝 `..`，老库里仍可能存着历史脏数据
    //   （比如迁移前写进去的 `..` 值）。这里的**唯一权威判定**是
    //   path.resolve 之后必须严格落在 uploads/avatars/ 之内 —— 其它一律不删。
    //   绝不能只写 startsWith('/uploads/avatars/')：那只是字符串前缀匹配，
    //   `/uploads/avatars/../../config.yaml` 会通过。
    if (row.avatar && row.avatar !== updates.avatar) {
      const abs = path.resolve(path.join(SERVER_ROOT, row.avatar));
      if (isInsideAvatars(abs)) {
        try {
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch { /* 删旧头像失败不致命 */ }
      }
    }
    db.prepare('UPDATE messages SET sender_avatar = ? WHERE sender_id = ?')
      .run(updates.avatar, userId);
  }

  const nr = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({
    user: {
      id: nr.id, username: nr.username, nickname: nr.nickname,
      avatar: nr.avatar || '', signature: nr.signature || '', role: nr.role || 'user'
    }
  });
});

// ============================================================
// 上传头像
// ============================================================
router.post('/avatar', authMiddleware, uploadGuard, (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.AVATAR_MAX / 1048576);
        return res.status(400).json({ error: `头像不能超过 ${mb}MB` });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    res.json({
      url: `/uploads/avatars/${req.file.filename}`,
      size: req.file.size
    });
  });
});

// ============================================================
// 上传文件
// ============================================================
router.post('/file', authMiddleware, uploadGuard, (req, res) => {
  uploadFile.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.FILE_MAX / 1048576);
        return res.status(400).json({ error: `文件不能超过 ${mb}MB` });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到文件' });

    const originalName = pickOriginalName(req, req.file.originalname) || '未命名';
    const mime = (req.file.mimetype || '').toLowerCase();
    const kind = mime.startsWith('image/') ? 'image'
      : mime.startsWith('video/') ? 'video'
        : mime.startsWith('audio/') ? 'audio'
          : 'file';

    let playback = null;
    if (kind === 'video' || kind === 'audio') {
      try {
        playback = await transcode.describe(path.join(config.FILE_DIR, req.file.filename));
      } catch (e) {
        console.error('[upload] 转码计划失败', e);
      }
    }

    res.json({
      url: `/uploads/files/${req.file.filename}`,
      size: req.file.size,
      name: originalName,
      mime: req.file.mimetype,
      kind,
      playback
    });
  });
});

// ============================================================
// 好友 / 群 快照
// ============================================================
router.get('/friends', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.signature
     FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.nickname`
  ).all(req.user.id);
  res.json({ friends: rows });
});

// ============================================================
// 【新增】用户公开资料：点击头像弹出的用户卡片用。
//   与 users:search 暴露的字段保持一致（id/username/nickname/avatar），
//   额外带上 signature。仅登录用户可查。
// ============================================================
router.get('/users/:id', authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '无效的用户 ID' });
  }
  const row = db.prepare(
    'SELECT id, username, nickname, avatar, signature, status FROM users WHERE id = ?'
  ).get(id);
  if (!row || row.status !== 'active') {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({
    user: {
      id: row.id, username: row.username, nickname: row.nickname,
      avatar: row.avatar || '', signature: row.signature || ''
    }
  });
});

router.get('/groups', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT g.id, g.name, g.avatar, g.owner_id,
       (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS member_count
     FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE m.user_id = ? ORDER BY g.name`
  ).all(req.user.id);
  res.json({ groups: rows });
});

module.exports = router;