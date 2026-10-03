// src/services/stickers.js
//
// 表情包系统。
//
// 【本次改动】
//   · 表情图片改用 assets.ingestStickers：独立目录 custom/{uid}/sticker/，
//     不写 assets 表 → 不出现在"我的资源库"，表情在专门的库里
//   · 新增 lookupByUrl：聊天里根据 fileUrl 反查「该表情属于哪个包 / 我是否拥有」
//   · grantPackFromProduct：把商品文件直接按 sha 落盘到买家表情库
//   · sticker_items 表使用 sha256 / size 列（配额统计与去重）
//
// [FIX] addItems 里 INSERT 的第一列 pack_id 必须是占位符 `?`，
//   早先误写成字面量 NULL → 每次都撞 NOT NULL 约束失败。
//   grantPackFromProduct 里那段是对的（同样是 `?`）。
//
// [CHANGED] grantPackFromProduct 新增 source 参数（默认 'purchase'）：
//   · 'purchase' —— 买家购买商品后获得（原行为）
//   · 'author'   —— 作者上架表情包商品时给自己发一份（新场景，
//                   见 services/products.js::createProduct 里的发放逻辑）
//   两者在 UI 里都走 pack.isOwner 判断（显示"我的"），source 仅作数据归类。
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const assets = require('./assets');
const registry = require('../socket/registry');
const { normalizeImageUrl } = require('../utils/url');

const CFG = config.STICKER_CFG;

// ============================================================
// 工具
// ============================================================
function randomCode(len = CFG.share_code_len || 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function normalizeName(raw) {
  const n = (raw ?? '').toString().trim();
  if (!n) throw new Error('表情包名称不能为空');
  if (n.length > CFG.name_max_len) throw new Error(`名称最多 ${CFG.name_max_len} 字`);
  return n;
}

function normalizeDesc(raw) {
  return (raw ?? '').toString().trim().slice(0, CFG.description_max_len);
}

function packDto(row, extra = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description || '',
    coverUrl: row.cover_url || null,
    isPublic: !!row.is_public,
    shareCode: row.is_public ? (row.share_code || null) : null,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra
  };
}

function itemCount(packId) {
  return db.prepare('SELECT COUNT(*) AS c FROM sticker_items WHERE pack_id = ?').get(packId).c;
}

function isOwner(userId, packId) {
  const p = db.prepare('SELECT owner_id FROM sticker_packs WHERE id = ?').get(packId);
  return !!p && p.owner_id === userId;
}

function isSubscribed(userId, packId) {
  return !!db.prepare(
    'SELECT 1 FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?'
  ).get(userId, packId);
}

function subscriberIds(packId) {
  return db.prepare('SELECT user_id FROM user_sticker_packs WHERE pack_id = ?')
    .all(packId).map((r) => r.user_id);
}

function audienceIds(packId) {
  const p = db.prepare('SELECT owner_id FROM sticker_packs WHERE id = ?').get(packId);
  if (!p) return [];
  return Array.from(new Set([p.owner_id, ...subscriberIds(packId)]));
}

function notifyPackChanged(packId, reason) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) return;
  const payload = {
    packId,
    reason,
    pack: packDto(pack, { itemCount: itemCount(packId) }),
    at: Date.now()
  };
  for (const uid of audienceIds(packId)) {
    registry.sendTo(uid, 'stickers:pack:updated', payload);
  }
}

// ============================================================
// 表情包 CRUD
// ============================================================
function createPack(userId, body = {}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sticker_packs WHERE owner_id = ?')
    .get(userId).c;
  if (count >= CFG.max_packs_per_user) {
    throw new Error(`最多创建 ${CFG.max_packs_per_user} 个表情包`);
  }

  const name = normalizeName(body.name);
  const description = normalizeDesc(body.description);
  const coverUrl = normalizeImageUrl(body.coverUrl, '表情包封面');
  const now = Date.now();

  const info = db.prepare(
    `INSERT INTO sticker_packs
       (owner_id, name, description, cover_url, is_public, share_code, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, NULL, 'user', 'active', ?, ?)`
  ).run(userId, name, description, coverUrl, now, now);

  const id = Number(info.lastInsertRowid);

  db.prepare(
    'INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id, source, added_at) VALUES (?, ?, ?, ?)'
  ).run(userId, id, 'own', now);

  const row = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id);
  return packDto(row, { itemCount: 0, isOwner: true, subscribed: true });
}

function listPacks(userId) {
  const rows = db.prepare(
    `SELECT p.*, usp.source AS link_source, usp.added_at AS link_added_at,
            (SELECT COUNT(*) FROM sticker_items i WHERE i.pack_id = p.id) AS item_count,
            (SELECT COUNT(*) FROM user_sticker_packs s WHERE s.pack_id = p.id AND s.source = 'subscribe') AS subscriber_count
     FROM sticker_packs p
     JOIN user_sticker_packs usp ON usp.pack_id = p.id
     WHERE usp.user_id = ? AND p.status = 'active'
     ORDER BY (p.owner_id = ?) DESC, p.updated_at DESC`
  ).all(userId, userId);

  return rows.map((r) => packDto(r, {
    itemCount: r.item_count,
    subscriberCount: r.subscriber_count,
    isOwner: r.owner_id === userId,
    linkSource: r.link_source,
    subscribed: true
  }));
}

function canView(userId, pack) {
  if (pack.owner_id === userId) return true;
  if (isSubscribed(userId, pack.id)) return true;
  return !!pack.is_public;
}

function getPack(userId, packId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.status !== 'active') throw new Error('表情包已下架');
  if (!canView(userId, pack)) throw new Error('无权查看该表情包');

  const items = db.prepare(
    'SELECT * FROM sticker_items WHERE pack_id = ? ORDER BY sort_order, id'
  ).all(packId);

  return {
    pack: packDto(pack, {
      itemCount: items.length,
      isOwner: pack.owner_id === userId,
      subscribed: isSubscribed(userId, packId)
    }),
    items: items.map((i) => ({
      id: i.id,
      packId: i.pack_id,
      assetId: i.asset_id,
      url: i.url,
      name: i.name,
      sortOrder: i.sort_order,
      sha256: i.sha256 || null,
      size: i.size || null
    }))
  };
}

function updatePack(userId, packId, body = {}) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以修改');

  const sets = [];
  const args = [];

  if (body.name !== undefined) { sets.push('name = ?'); args.push(normalizeName(body.name)); }
  if (body.description !== undefined) {
    sets.push('description = ?'); args.push(normalizeDesc(body.description));
  }
  if (body.coverUrl !== undefined) {
    sets.push('cover_url = ?'); args.push(normalizeImageUrl(body.coverUrl, '表情包封面'));
  }

  let newCode = null;
  if (body.isPublic !== undefined) {
    const pub = !!body.isPublic;
    if (pub && !pack.share_code) {
      newCode = randomCode();
      let guard = 0;
      while (db.prepare('SELECT 1 FROM sticker_packs WHERE share_code = ?').get(newCode) && guard++ < 10) {
        newCode = randomCode();
      }
      sets.push('is_public = 1', 'share_code = ?');
      args.push(newCode);
    } else {
      sets.push('is_public = ?');
      args.push(pub ? 1 : 0);
    }
  }

  if (sets.length === 0) throw new Error('没有需要更新的内容');
  sets.push('updated_at = ?');
  args.push(Date.now(), packId);
  db.prepare(`UPDATE sticker_packs SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  notifyPackChanged(packId, 'updated');
  return getPack(userId, packId).pack;
}

function deletePack(userId, packId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以删除');

  const audience = audienceIds(packId);
  db.prepare('DELETE FROM sticker_items WHERE pack_id = ?').run(packId);
  db.prepare('DELETE FROM user_sticker_packs WHERE pack_id = ?').run(packId);
  db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(packId);

  for (const uid of audience) {
    registry.sendTo(uid, 'stickers:pack:removed', { packId, at: Date.now() });
  }
  return true;
}

// ============================================================
// 表情项（改用 ingestStickers）
// ============================================================
function addItems(userId, packId, files) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以添加表情');

  const current = itemCount(packId);
  if (current + files.length > CFG.max_items_per_pack) {
    throw new Error(`每个表情包最多 ${CFG.max_items_per_pack} 个表情`);
  }

  const out = assets.ingestStickers(userId, files);

  const now = Date.now();
  // [FIX] 第一列 pack_id 必须是占位符 `?`（原先是字面量 NULL，
  //   撞了 sticker_items.pack_id 的 NOT NULL 约束）
  const ins = db.prepare(
    `INSERT INTO sticker_items
       (pack_id, asset_id, url, name, sort_order, sha256, size, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
  );
  let order = current;
  const items = [];
  for (const a of out.items) {
    const info = ins.run(packId, a.url, a.name, order++, a.sha256, a.size, now);
    items.push({
      id: Number(info.lastInsertRowid),
      packId,
      assetId: null,
      url: a.url,
      name: a.name,
      sortOrder: order - 1,
      sha256: a.sha256,
      size: a.size
    });
  }

  db.prepare('UPDATE sticker_packs SET updated_at = ? WHERE id = ?').run(now, packId);
  if (!pack.cover_url && items.length) {
    db.prepare('UPDATE sticker_packs SET cover_url = ? WHERE id = ?').run(items[0].url, packId);
  }
  notifyPackChanged(packId, 'items_added');

  return {
    items,
    created: out.created,
    deduped: out.deduped,
    usage: assets.usage(userId)
  };
}

function reorderItems(userId, packId, order) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以排序');
  if (!Array.isArray(order)) throw new Error('order 必须是数组');

  const all = db.prepare('SELECT id FROM sticker_items WHERE pack_id = ?').all(packId)
    .map((r) => r.id);
  const set = new Set(all);
  const ordered = order.map(Number).filter((id) => set.has(id));
  for (const id of all) if (!ordered.includes(id)) ordered.push(id);

  const upd = db.prepare('UPDATE sticker_items SET sort_order = ? WHERE id = ? AND pack_id = ?');
  ordered.forEach((id, i) => upd.run(i, id, packId));
  db.prepare('UPDATE sticker_packs SET updated_at = ? WHERE id = ?').run(Date.now(), packId);

  notifyPackChanged(packId, 'reordered');
  return getPack(userId, packId).items;
}

function removeItem(userId, packId, itemId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以删除表情');

  const item = db.prepare('SELECT * FROM sticker_items WHERE id = ? AND pack_id = ?')
    .get(itemId, packId);
  if (!item) throw new Error('表情不存在');

  db.prepare('DELETE FROM sticker_items WHERE id = ?').run(itemId);
  if (pack.cover_url === item.url) {
    const next = db.prepare(
      'SELECT url FROM sticker_items WHERE pack_id = ? ORDER BY sort_order, id LIMIT 1'
    ).get(packId);
    db.prepare('UPDATE sticker_packs SET cover_url = ? WHERE id = ?')
      .run(next?.url || null, packId);
  }
  db.prepare('UPDATE sticker_packs SET updated_at = ? WHERE id = ?').run(Date.now(), packId);

  // 表情独立落盘，删完检查这个 url 还有没有其他人引用（别的包可能共享同一 sha）
  const still = db.prepare('SELECT 1 FROM sticker_items WHERE url = ? LIMIT 1').get(item.url);
  if (!still) {
    const abs = assets.absFromUrl(item.url);
    if (abs && assets.isInsideDir(abs, config.CUSTOM_DIR)) {
      assets.safeUnlink(abs);
    }
  }

  notifyPackChanged(packId, 'item_removed');
  return true;
}

// ============================================================
// 分享 / 订阅
// ============================================================
function sharePack(userId, packId, regenerate = false) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以分享');

  let code = pack.share_code;
  if (!code || regenerate) {
    code = randomCode();
    let guard = 0;
    while (db.prepare('SELECT 1 FROM sticker_packs WHERE share_code = ? AND id != ?').get(code, packId)
           && guard++ < 10) {
      code = randomCode();
    }
  }

  db.prepare('UPDATE sticker_packs SET is_public = 1, share_code = ?, updated_at = ? WHERE id = ?')
    .run(code, Date.now(), packId);

  notifyPackChanged(packId, 'shared');
  return { packId, shareCode: code, isPublic: true };
}

function setPrivate(userId, packId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id !== userId) throw new Error('只有作者可以修改');
  db.prepare('UPDATE sticker_packs SET is_public = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), packId);
  notifyPackChanged(packId, 'updated');
  return getPack(userId, packId).pack;
}

function subscribe(userId, rawCode) {
  const code = (rawCode ?? '').toString().trim().toUpperCase();
  if (!code) throw new Error('请输入分享码');

  const pack = db.prepare('SELECT * FROM sticker_packs WHERE share_code = ?').get(code);
  if (!pack) throw new Error('分享码无效');
  if (pack.status !== 'active') throw new Error('该表情包已下架');
  if (!pack.is_public) throw new Error('该表情包未公开分享');
  if (pack.owner_id === userId) throw new Error('这是你自己的表情包');

  const exists = db.prepare(
    'SELECT source FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?'
  ).get(userId, pack.id);
  if (exists) throw new Error('已经订阅过了');

  db.prepare(
    'INSERT INTO user_sticker_packs (user_id, pack_id, source, added_at) VALUES (?, ?, ?, ?)'
  ).run(userId, pack.id, 'subscribe', Date.now());

  registry.sendTo(pack.owner_id, 'stickers:pack:subscribed', {
    packId: pack.id, userId, at: Date.now()
  });

  return getPack(userId, pack.id).pack;
}

function unsubscribe(userId, packId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) throw new Error('表情包不存在');
  if (pack.owner_id === userId) throw new Error('不能取消订阅自己的表情包');

  const info = db.prepare(
    "DELETE FROM user_sticker_packs WHERE user_id = ? AND pack_id = ? AND source = 'subscribe'"
  ).run(userId, packId);
  return { removed: info.changes > 0 };
}

// ============================================================
// 通过 url 反查：这个表情属于哪个包？我拥有/订阅了吗？
// 聊天界面右键表情消息时用，决定是否显示「购买」入口
// ============================================================
function lookupByUrl(userId, url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/custom/')) return null;

  const row = db.prepare(
    `SELECT si.id AS itemId, si.name AS itemName,
            sp.id AS packId, sp.name AS packName, sp.owner_id AS packOwnerId,
            sp.source AS packSource, sp.status AS packStatus, sp.product_id AS packProductId
     FROM sticker_items si
     JOIN sticker_packs sp ON sp.id = si.pack_id
     WHERE si.url = ? AND sp.status = 'active'
     LIMIT 1`
  ).get(url);
  if (!row) return null;

  const owned = isOwner(userId, row.packId);
  const subscribed = isSubscribed(userId, row.packId);

  // [FIX] 商品跳转改从 sticker_packs.product_id 直读。
  //   原实现查 assets.ref_id，但表情包发货根本不写 assets 表，
  //   且那条 UPDATE ... LIMIT 1 在 SQLite 上必然抛错被吞 —— 功能从未生效。
  const productId = row.packProductId || null;

  return {
    itemId: row.itemId,
    itemName: row.itemName || '',
    packId: row.packId,
    packName: row.packName,
    packOwnerId: row.packOwnerId,
    packSource: row.packSource,
    owned,
    subscribed,
    usable: owned || subscribed,
    productId
  };
}

// ============================================================
// 供商城使用：把商品素材变成某用户自己的表情包
//
// [CHANGED] 新增 `source` 参数（默认 'purchase'）：
//   · 'purchase' —— 买家购买商品后获得（原行为）
//   · 'author'   —— 作者上架商品时给自己发一份（新场景，见 services/products.js）
//   两者在 UI 里都走 pack.isOwner 判断（显示"我的"），source 仅作数据归类。
// ============================================================
function grantPackFromProduct({
  ownerId, name, description, files, coverUrl, productId,
  source = 'purchase'
}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sticker_packs WHERE owner_id = ?')
    .get(ownerId).c;
  if (count >= CFG.max_packs_per_user) {
    throw new Error(`最多创建 ${CFG.max_packs_per_user} 个表情包`);
  }

  // [FIX] 商品文件必须全部存在：原实现对缺失文件静默 continue，
  //       全部丢失时会创建 0 表情的空包而订单已 paid（扣款无货）。
  const validFiles = [];
  for (const f of files || []) {
    const src = assets.absFromUrl(f.url);
    if (!src || !assets.isInsideDir(src, config.SHOP_DIR) || !fs.existsSync(src)) {
      throw new Error(`商品文件丢失：${f.url}`);
    }
    validFiles.push({ ...f, _src: src });
  }
  if (validFiles.length === 0) {
    throw new Error('表情包商品没有可用的图片文件');
  }

  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO sticker_packs
       (owner_id, name, description, cover_url, is_public, share_code, source, status, product_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, NULL, ?, 'active', ?, ?, ?)`
  ).run(ownerId, normalizeName(name), normalizeDesc(description), coverUrl || null, source, productId || null, now, now);
  const packId = Number(info.lastInsertRowid);

  db.prepare(
    'INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id, source, added_at) VALUES (?, ?, ?, ?)'
  ).run(ownerId, packId, source, now);

  // 表情独立落盘：按 sha 复制到 custom/{uid}/sticker/，并写 sticker_items
  const ins = db.prepare(
    `INSERT INTO sticker_items
       (pack_id, asset_id, url, name, sort_order, sha256, size, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
  );

  const dir = path.join(config.CUSTOM_DIR, String(ownerId), 'sticker');
  fs.mkdirSync(dir, { recursive: true });

  let order = 0;
  for (const f of validFiles) {
    const src = f._src;
    const sha = assets.sha256File(src);
    const ext = path.extname(f.name || src) || '.png';
    const dest = path.join(dir, `${sha}${ext}`);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    const url = assets.relUrl(dest);
    const size = fs.statSync(dest).size;
    ins.run(packId, url, (f.name || '表情').slice(0, 100), order++, sha, size, now);
  }

  if (coverUrl) {
    db.prepare('UPDATE sticker_packs SET cover_url = ? WHERE id = ?').run(coverUrl, packId);
  }

  return packId;
}

module.exports = {
  createPack, listPacks, getPack, updatePack, deletePack,
  addItems, reorderItems, removeItem,
  sharePack, setPrivate, subscribe, unsubscribe,
  notifyPackChanged, grantPackFromProduct, lookupByUrl,
  itemCount, isSubscribed, subscriberIds, audienceIds
};