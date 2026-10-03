// src/services/rooms.js
//
// 房间设置业务：目前只服务「公共聊天」的图标。
//
// 公共聊天（roomType = 'public'，roomId = 'public'）不是数据库里的实体，
// 它的图标单独存在 room_settings(room_key = 'public')。
// 权限沿用 roles.capabilities.manage_public_room（默认 100 级＝只有开发者）。
//
// socket 与 REST 共用本文件，保证两条通道行为一致。
//
const { db } = require('../db');
const helpers = require('../socket/helpers');
const registry = require('../socket/registry');
const { sanitizeAvatar } = require('../utils/avatar');
const { can } = require('./permissions');

const SETTING_KEY = helpers.PUBLIC_ROOM_KEY;

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 公共聊天房信息（任何人可读） */
function getPublicRoom() {
  return helpers.getPublicRoom();
}

/**
 * 规范化房间图标：
 *   ''            → 清除
 *   /uploads/...  → 上传的图片
 *   http(s)://... → 外链图片
 *   '🐱'          → 单个 emoji / 字符
 * 与用户头像同一套规则（utils/avatar.js），拒绝 javascript: 之类的注入。
 */
function normalizeIcon(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') throw fail('图标格式不正确');
  const s = raw.trim();
  if (!s) return '';
  const safe = sanitizeAvatar(s);
  if (!safe) throw fail('图标格式不正确');
  return safe;
}

/** 更换公共聊天图标（需要 manage_public_room 能力，默认只有开发者） */
function setPublicRoomIcon(user, icon) {
  if (!can(user.role, 'manage_public_room')) {
    throw fail('只有开发者可以更换公共聊天图标', 403);
  }

  const next = normalizeIcon(icon);
  const now = Date.now();

  db.prepare(
    `INSERT INTO room_settings (room_key, icon, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_key) DO UPDATE SET
       icon = excluded.icon,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(SETTING_KEY, next, user.id, now);

  const room = helpers.getPublicRoom();
  // 公共聊天所有人可见，直接全服广播
  registry.broadcastAll('room:public:updated', room);
  return room;
}

module.exports = { getPublicRoom, setPublicRoomIcon, normalizeIcon };
