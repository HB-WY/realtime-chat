// src/services/preferences.js
//
// 个性化偏好：全局背景 / 单房间背景 / 气泡配置(JSON) / 字号。
// 【本次改动】setPreferences 包事务：
//   原实现 global 与 rooms 分开写，某个 roomKey 越权抛错时
//   global 和前几个 room 已经提交 —— 用户看到 400，实际改了一半。
//
const { db } = require('../db');
const { transaction } = require('../db/tx');
const config = require('../config');

const CFG = config.PREF_CFG;
const FONT = CFG.font_size;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9_\-./]{1,300}$/;

// ============================================================
// 校验
// ============================================================
function normalizeBackground(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('背景必须是字符串');
  const s = raw.trim();
  if (!s) return null;
  if (s.length > CFG.background_max_len) throw new Error('背景值过长');
  if (HEX.test(s)) return s.toLowerCase();
  if (UPLOAD_PATH.test(s) && !s.includes('..')) return s;
  throw new Error('背景只支持 #RRGGBB 颜色或 /uploads/ 图片');
}

function normalizeColor(raw, field) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new Error(`${field} 必须是字符串`);
  const s = raw.trim();
  if (HEX.test(s)) return s.toLowerCase();
  if (s === 'transparent') return s;
  throw new Error(`${field} 只支持 #RRGGBB 颜色`);
}

function normalizeImage(raw, field) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new Error(`${field} 必须是字符串`);
  const s = raw.trim();
  if (!UPLOAD_PATH.test(s) || s.includes('..')) {
    throw new Error(`${field} 只支持 /uploads/ 图片`);
  }
  return s;
}

function normalizeSide(raw, side) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`bubble.${side} 必须是对象`);
  }
  const out = {};
  out.bg = normalizeColor(raw.bg, `bubble.${side}.bg`);
  out.color = normalizeColor(raw.color, `bubble.${side}.color`);
  out.border = normalizeColor(raw.border, `bubble.${side}.border`);
  out.image = normalizeImage(raw.image, `bubble.${side}.image`);

  if (raw.radius !== undefined && raw.radius !== null) {
    const r = Number(raw.radius);
    if (!Number.isFinite(r) || r < 0 || r > 40) {
      throw new Error(`bubble.${side}.radius 需为 0-40`);
    }
    out.radius = Math.round(r);
  } else {
    out.radius = undefined;
  }

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function normalizeBubble(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string') {
    if (raw.length > CFG.bubble_max_len) throw new Error('气泡配置过长');
    try { raw = JSON.parse(raw); } catch { throw new Error('气泡配置不是合法 JSON'); }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('气泡配置必须是对象');

  const out = {};
  const self = normalizeSide(raw.self, 'self');
  const other = normalizeSide(raw.other, 'other');
  if (self) out.self = self;
  if (other) out.other = other;

  const serialized = JSON.stringify(out);
  if (serialized.length > CFG.bubble_max_len) throw new Error('气泡配置过长');
  if (Object.keys(out).length === 0) return null;
  return out;
}

function normalizeFontSize(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('字号必须是数字');
  if (n < FONT.min || n > FONT.max) {
    throw new Error(`字号需为 ${FONT.min}-${FONT.max}`);
  }
  return Math.round(n);
}

function assertRoomKey(userId, roomKey) {
  if (typeof roomKey !== 'string' || !roomKey || roomKey.length > 64) {
    throw new Error('房间标识非法');
  }
  if (roomKey === 'public') return roomKey;

  let m = roomKey.match(/^p_(\d+)_(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a !== userId && b !== userId) throw new Error('无权设置该房间');
    return roomKey;
  }

  m = roomKey.match(/^g_(\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const member = db.prepare(
      'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
    ).get(gid, userId);
    if (!member) throw new Error('无权设置该房间');
    return roomKey;
  }

  throw new Error('房间标识非法');
}

// ============================================================
// 读写
// ============================================================
function parseBubble(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function getPreferences(userId) {
  const g = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  const rooms = db.prepare(
    'SELECT room_key, background, updated_at FROM room_preferences WHERE user_id = ? ORDER BY room_key'
  ).all(userId);

  const roomMap = {};
  for (const r of rooms) {
    roomMap[r.room_key] = { roomKey: r.room_key, background: r.background || null, updatedAt: r.updated_at };
  }

  return {
    global: g
      ? {
          background: g.background || null,
          bubble: parseBubble(g.bubble),
          fontSize: typeof g.font_size === 'number' ? g.font_size : null,
          updatedAt: g.updated_at,
          updatedAtIso: new Date(g.updated_at).toISOString()
        }
      : { background: null, bubble: null, fontSize: null, updatedAt: null },
    rooms: roomMap,
    defaults: { fontSize: null },
    limits: {
      fontMin: FONT.min,
      fontMax: FONT.max,
      maxRooms: CFG.max_rooms,
      backgroundMaxLen: CFG.background_max_len,
      bubbleMaxLen: CFG.bubble_max_len
    }
  };
}

/** 事务包裹的 setPreferences 主体 */
const setPreferencesImpl = (userId, body = {}) => {
  const now = Date.now();
  let touchedGlobal = false;
  let touchedRooms = 0;

  const gPatch = {};
  if (body.global && typeof body.global === 'object') {
    if ('background' in body.global) {
      gPatch.background = normalizeBackground(body.global.background);
    }
    if ('bubble' in body.global) {
      gPatch.bubble = normalizeBubble(body.global.bubble);
    }
    if ('fontSize' in body.global) {
      gPatch.fontSize = normalizeFontSize(body.global.fontSize);
    }
    touchedGlobal = Object.keys(gPatch).length > 0;
  }

  if (touchedGlobal) {
    const exists = db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(userId);
    if (!exists) {
      db.prepare(
        `INSERT INTO user_preferences (user_id, background, bubble, font_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        gPatch.background !== undefined ? gPatch.background : null,
        gPatch.bubble !== undefined && gPatch.bubble ? JSON.stringify(gPatch.bubble) : null,
        gPatch.fontSize !== undefined ? gPatch.fontSize : null,
        now, now
      );
    } else {
      const sets = [];
      const args = [];
      if (gPatch.background !== undefined) { sets.push('background = ?'); args.push(gPatch.background); }
      if (gPatch.bubble !== undefined) {
        sets.push('bubble = ?');
        args.push(gPatch.bubble ? JSON.stringify(gPatch.bubble) : null);
      }
      if (gPatch.fontSize !== undefined) { sets.push('font_size = ?'); args.push(gPatch.fontSize); }
      sets.push('updated_at = ?');
      args.push(now, userId);
      db.prepare(`UPDATE user_preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...args);
    }
  }

  const roomList = [];
  if (body.room && typeof body.room === 'object') roomList.push(body.room);
  if (Array.isArray(body.rooms)) for (const r of body.rooms) roomList.push(r);

  for (const r of roomList) {
    if (!r || typeof r !== 'object') throw new Error('房间偏好格式错误');
    // assertRoomKey 越权会抛错 → 事务整体回滚
    const key = assertRoomKey(userId, r.roomKey ?? r.key);
    const bg = normalizeBackground(r.background);

    const roomCount = db.prepare(
      'SELECT COUNT(*) AS c FROM room_preferences WHERE user_id = ?'
    ).get(userId).c;
    const exists = db.prepare(
      'SELECT room_key FROM room_preferences WHERE user_id = ? AND room_key = ?'
    ).get(userId, key);

    if (!exists && roomCount >= CFG.max_rooms) throw new Error('单房间背景数量已达上限');

    if (bg === null) {
      db.prepare('DELETE FROM room_preferences WHERE user_id = ? AND room_key = ?').run(userId, key);
    } else if (exists) {
      db.prepare(
        'UPDATE room_preferences SET background = ?, updated_at = ? WHERE user_id = ? AND room_key = ?'
      ).run(bg, now, userId, key);
    } else {
      db.prepare(
        `INSERT INTO room_preferences (user_id, room_key, background, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, key, bg, now, now);
    }
    touchedRooms++;
  }

  if (!touchedGlobal && touchedRooms === 0) {
    throw new Error('没有需要更新的内容');
  }

  return getPreferences(userId);
};

const setPreferencesTx = transaction(setPreferencesImpl);

function setPreferences(userId, body) {
  return setPreferencesTx(userId, body);
}

function deleteRoomPreference(userId, roomKey) {
  const key = assertRoomKey(userId, roomKey);
  db.prepare('DELETE FROM room_preferences WHERE user_id = ? AND room_key = ?').run(userId, key);
  return getPreferences(userId);
}

function purgeRoomPreferences(roomKey) {
  db.prepare('DELETE FROM room_preferences WHERE room_key = ?').run(roomKey);
}

function purgeRoomPreference(userId, roomKey) {
  db.prepare('DELETE FROM room_preferences WHERE user_id = ? AND room_key = ?').run(userId, roomKey);
}

module.exports = {
  getPreferences, setPreferences, deleteRoomPreference,
  purgeRoomPreferences, purgeRoomPreference,
  normalizeBackground, normalizeBubble, normalizeFontSize, assertRoomKey
};