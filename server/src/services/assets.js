// src/services/assets.js
//
// 统一资源池（背景 / 气泡素材 / 通用图片）。
//
// 【本次改动汇总】
//   · ingestUploads 加事务 + 提前总量校验：批量时任何一张配额不足 → 整批回滚，
//     不再出现"前几张已入库，后一张报错"的半成功状态
//   · 新增 ingestStickers：表情图片走独立入口，直接落盘
//     uploads/custom/{uid}/sticker/，**不写 assets 表**
//     → 表情不出现在"我的资源库"里（表情有专门的库）
//   · listAssets 默认排除 kind='sticker'
//     （即使老库里有存量表情记录，也不会混入资源库列表）
//   · usage 计入 sticker_items 占用的配额（表情虽不写 assets，但要占配额）
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const { transaction } = require('../db/tx');
const config = require('../config');

const CFG = config.ASSETS_CFG;
const CUSTOM_DIR = config.CUSTOM_DIR;
const TMP_DIR = config.TMP_DIR;

const KINDS = ['image', 'background', 'bubble', 'sticker'];

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
};

const ALLOWED_MIME = new Set(CFG.allowed_mime || Object.keys(MIME_EXT));
const ALLOWED_EXT = new Set((CFG.allowed_ext || Object.values(MIME_EXT)).map((e) => e.toLowerCase()));

// 提示文案从白名单现算，避免「加了格式忘了改文案」两边漂移
const SUPPORTED_LABEL = [...new Set(
  [...ALLOWED_EXT].map((e) => e.replace(/^\./, '').replace(/^jpeg$/, 'JPG').toUpperCase())
)].join(' / ');
const UNSUPPORTED_MSG = `只支持 ${SUPPORTED_LABEL} 图片`;

// ============================================================
// 工具
// ============================================================
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extFor(mime, originalName) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const ext = path.extname(originalName || '').toLowerCase();
  return ALLOWED_EXT.has(ext) ? ext : '.png';
}

function ownerDir(ownerId) {
  const dir = path.join(CUSTOM_DIR, String(ownerId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stickerDir(ownerId) {
  const dir = path.join(CUSTOM_DIR, String(ownerId), 'sticker');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * 判断 child 是否严格位于 parent 目录内。
 * [SEC] 必须带路径分隔符比较：只写 `child.startsWith(parent)` 时，
 *       `uploads-old/x` 会被误判为在 `uploads` 内（前缀相同）。
 */
function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/** /uploads/custom/1/abc.png → 绝对路径（越界 / . / .. 一律拒绝） */
function absFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const rel = url.replace(/^\/uploads\//, '');
  if (!rel || rel.includes('\0')) return null;

  // [SEC] 逐段检查，显式拒绝 . 和 ..（含 Windows 反斜杠写法），
  //       避免 /uploads/../uploads-old/x 这类前缀逃逸。
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === '..' || s === '.')) return null;

  const abs = path.resolve(config.UPLOAD_ROOT, rel);
  if (!isInsideDir(abs, config.UPLOAD_ROOT)) return null;
  return abs;
}

function relUrl(absPath) {
  const rel = path.relative(config.UPLOAD_ROOT, absPath).split(path.sep).join('/');
  return `/uploads/${rel}`;
}

function toDto(row) {
  if (!row) return null;
  let meta = null;
  if (row.meta) {
    try { meta = JSON.parse(row.meta); } catch { meta = null; }
  }
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    sha256: row.sha256,
    name: row.file_name || '',
    mime: row.mime || '',
    size: row.size || 0,
    meta,
    source: row.source,
    refType: row.ref_type || null,
    refId: row.ref_id || null,
    createdAt: row.created_at
  };
}

// ============================================================
// 配额
// ============================================================
function usage(ownerId) {
  // assets 去重计量（按 sha256）
  const row = db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS files
     FROM (SELECT DISTINCT sha256, size FROM assets WHERE owner_id = ?)`
  ).get(ownerId);

  // 表情不写 assets 表，但要占配额：从 sticker_items 单独统计
  const stickerRow = db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS files
     FROM (
       SELECT DISTINCT si.sha256, si.size
       FROM sticker_items si
       JOIN sticker_packs sp ON sp.id = si.pack_id
       WHERE sp.owner_id = ? AND si.sha256 IS NOT NULL
     )`
  ).get(ownerId);

  return {
    used: (row?.used || 0) + (stickerRow?.used || 0),
    files: (row?.files || 0) + (stickerRow?.files || 0),
    // [CHANGED] quota_bytes ≤ 0 表示不限制总用量（单次批量与单文件上限仍在）
    quota: CFG.quota_bytes > 0 ? CFG.quota_bytes : 0,
    batchMax: CFG.batch_max_bytes,
    maxFileSize: config.ASSET_MAX
  };
}

function assertQuota(ownerId, extraBytes) {
  if (!(CFG.quota_bytes > 0)) return; // 不限总量
  const { used } = usage(ownerId);
  if (used + extraBytes > CFG.quota_bytes) {
    throw new Error(
      `资源池配额不足：已用 ${(used / 1048576).toFixed(1)}MB / ` +
      `${(CFG.quota_bytes / 1048576).toFixed(0)}MB`
    );
  }
}

// ============================================================
// 单文件入库（资源池内部用）
// ============================================================
/**
 * 把一个已经在磁盘上的文件收进某用户的资源池。
 * @param {object} p
 * @param {number} p.ownerId
 * @param {string} p.srcPath      源文件绝对路径（会保留，不移除）
 * @param {string} p.originalName
 * @param {string} p.mime
 * @param {string} [p.kind]
 * @param {string} [p.source]     upload | purchase | subscribe
 * @param {string} [p.refType]
 * @param {number} [p.refId]
 * @param {object} [p.meta]       额外 JSON（例如气泡主题配置）
 */
function addFile(p) {
  const {
    ownerId, srcPath, originalName, mime,
    kind = 'image', source = 'upload', refType = null, refId = null, meta = null
  } = p;

  if (!ALLOWED_MIME.has(mime)) throw new Error(UNSUPPORTED_MSG);
  const size = fs.statSync(srcPath).size;
  if (size > config.ASSET_MAX) {
    throw new Error(`单文件不能超过 ${Math.round(config.ASSET_MAX / 1048576)}MB`);
  }

  const sha = sha256File(srcPath);

  const existing = db.prepare(
    'SELECT * FROM assets WHERE owner_id = ? AND kind = ? AND sha256 = ?'
  ).get(ownerId, kind, sha);
  if (existing) return { asset: toDto(existing), deduped: true };

  assertQuota(ownerId, size);

  const dir = ownerDir(ownerId);
  const dest = path.join(dir, `${sha}${extFor(mime, originalName)}`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(srcPath, dest);
  }

  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO assets
       (owner_id, kind, sha256, url, file_name, mime, size, meta,
        source, ref_type, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ownerId, kind, sha, relUrl(dest),
    (originalName || '未命名').toString().slice(0, 200),
    mime, size,
    meta ? JSON.stringify(meta).slice(0, 8000) : null,
    source, refType, refId, now
  );

  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(info.lastInsertRowid));
  return { asset: toDto(row), deduped: false };
}

// ============================================================
// 批量入库（资源池）—— 事务 + 提前总量校验
// ============================================================
/**
 * 收编 multer 落在 TMP_DIR 的上传文件。
 *
 * [FIX] 事务包裹 + 提前总量校验，杜绝"半成功"：
 *   · 提前校验：在事务之前先 sum 一次，避免事务里 copy 了大量文件才发现超配额
 *   · 事务：addFile 里任何一步抛错，前面已写入的记录全部回滚
 *
 * [NOTE] 文件系统操作（copyFileSync）不进事务，所以极端情况下仍可能留下
 *        孤儿文件 —— 由 `cleanup_orphan_files.mjs` 兜底清理。
 */
function ingestUploads(ownerId, files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) throw new Error('未收到文件');
  if (list.length > (CFG.max_files_per_request || 50)) {
    throw new Error(`单次最多上传 ${CFG.max_files_per_request} 个文件`);
  }

  const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
  if (totalBytes > CFG.batch_max_bytes) {
    for (const f of list) safeUnlink(f.path);
    throw new Error(
      `单次上传总大小不能超过 ${Math.round(CFG.batch_max_bytes / 1048576)}MB`
    );
  }

  // 提前校验：不动任何文件系统状态，直接拒绝（总量不限时跳过）
  {
    const { used } = usage(ownerId);
    if (CFG.quota_bytes > 0 && used + totalBytes > CFG.quota_bytes) {
      for (const f of list) safeUnlink(f.path);
      throw new Error(
        `资源池配额不足：已用 ${(used / 1048576).toFixed(1)}MB / ` +
        `${(CFG.quota_bytes / 1048576).toFixed(0)}MB`
      );
    }
  }

  const run = transaction(() => {
    const created = [];
    const deduped = [];
    for (const f of list) {
      const r = addFile({
        ownerId,
        srcPath: f.path,
        originalName: f.originalname,
        mime: f.mimetype,
        kind: opts.kind || 'image',
        source: opts.source || 'upload',
        refType: opts.refType || null,
        refId: opts.refId || null,
        meta: opts.meta || null
      });
      if (r.deduped) deduped.push(r.asset);
      else created.push(r.asset);
    }
    return { created, deduped, assets: [...created, ...deduped] };
  });

  try {
    return run();
  } finally {
    // 无论成功失败都清理临时文件
    for (const f of list) safeUnlink(f.path);
  }
}

// ============================================================
// 表情专用入库（不写 assets 表）
// ============================================================
/**
 * [NEW] 表情图片独立入库：
 *   · 落盘 uploads/custom/{uid}/sticker/{sha}{ext}（与资源池的图片分开目录）
 *   · **不写 assets 表** → 不出现在"我的资源库"里，表情在专门的库里
 *   · 配额由 usage() 单独统计 sticker_items 占用的部分
 *
 * @returns {{items:Array<{url,sha256,size,name,mime}>, created:number, deduped:number}}
 */
function ingestStickers(ownerId, files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) throw new Error('未收到文件');
  if (list.length > (CFG.max_files_per_request || 50)) {
    throw new Error(`单次最多上传 ${CFG.max_files_per_request} 个表情`);
  }

  const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
  const { used } = usage(ownerId);
  if (CFG.quota_bytes > 0 && used + totalBytes > CFG.quota_bytes) {
    for (const f of list) safeUnlink(f.path);
    throw new Error(
      `配额不足：已用 ${(used / 1048576).toFixed(1)}MB / ` +
      `${(CFG.quota_bytes / 1048576).toFixed(0)}MB`
    );
  }

  const dir = stickerDir(ownerId);
  const out = [];
  let created = 0;
  let deduped = 0;

  try {
    for (const f of list) {
      if (!ALLOWED_MIME.has(f.mimetype)) throw new Error(UNSUPPORTED_MSG);
      const size = f.size || fs.statSync(f.path).size;
      if (size > config.ASSET_MAX) {
        throw new Error(`单张表情不能超过 ${Math.round(config.ASSET_MAX / 1048576)}MB`);
      }
      const sha = sha256File(f.path);
      const ext = extFor(f.mimetype, f.originalname);
      const dest = path.join(dir, `${sha}${ext}`);
      if (fs.existsSync(dest)) {
        deduped += 1;
      } else {
        fs.copyFileSync(f.path, dest);
        created += 1;
      }
      out.push({
        url: relUrl(dest),
        sha256: sha,
        size,
        name: (f.originalname || '表情').slice(0, 100),
        mime: f.mimetype
      });
    }
  } finally {
    for (const f of list) safeUnlink(f.path);
  }

  return { items: out, created, deduped };
}

// ============================================================
// 查询 / 删除
// ============================================================
function listAssets(ownerId, { kind = null, limit = 200 } = {}) {
  const lim = Math.min(Number(limit) || 200, 500);

  // [FIX] 排除表情：表情在专门的库里，不在"我的资源库"里混着。
  //   即使老库里有存量 kind='sticker' 的记录也不展示。
  if (kind && kind !== 'sticker') {
    return db.prepare(
      'SELECT * FROM assets WHERE owner_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?'
    ).all(ownerId, kind, lim).map(toDto);
  }
  return db.prepare(
    "SELECT * FROM assets WHERE owner_id = ? AND kind != 'sticker' ORDER BY created_at DESC LIMIT ?"
  ).all(ownerId, lim).map(toDto);
}

function getAsset(ownerId, id) {
  const row = db.prepare('SELECT * FROM assets WHERE id = ? AND owner_id = ?').get(id, ownerId);
  return toDto(row);
}

function deleteAsset(ownerId, id) {
  const row = db.prepare('SELECT * FROM assets WHERE id = ? AND owner_id = ?').get(id, ownerId);
  if (!row) throw new Error('资源不存在');

  const usedBySticker = db.prepare(
    'SELECT COUNT(*) AS c FROM sticker_items WHERE asset_id = ?'
  ).get(id).c;
  if (usedBySticker > 0) throw new Error('该图片已被表情包引用，请先在表情包中移除');

  db.prepare('DELETE FROM assets WHERE id = ?').run(id);

  // 同一 sha256 可能还被其它 kind 的记录引用，只有全没了才删文件
  const still = db.prepare('SELECT COUNT(*) AS c FROM assets WHERE owner_id = ? AND sha256 = ?')
    .get(ownerId, row.sha256).c;
  if (still === 0) {
    const abs = absFromUrl(row.url);
    if (abs && isInsideDir(abs, CUSTOM_DIR)) safeUnlink(abs);
  }
  return true;
}

/** 供表情包 / 商城使用：判断某 url 是否属于该用户的资源池 */
function ownsUrl(ownerId, url) {
  return !!db.prepare('SELECT 1 FROM assets WHERE owner_id = ? AND url = ?').get(ownerId, url);
}

/** 从 /uploads/shop/... 的商品文件复制进买家资源库 */
function grantFromProductFile({ ownerId, fileUrl, fileName, mime, kind, meta, productId }) {
  const src = absFromUrl(fileUrl);
  if (!src || !fs.existsSync(src)) throw new Error(`商品文件丢失：${fileUrl}`);
  // [SEC] 商品素材只能来自商品上传目录（uploads/shop）。
  if (!isInsideDir(src, config.SHOP_DIR)) throw new Error('商品文件路径非法');
  const rawMime = (mime || '').toString().toLowerCase();
  const useMime = ALLOWED_MIME.has(rawMime) ? rawMime : guessMime(fileName);
  return addFile({
    ownerId,
    srcPath: src,
    originalName: fileName,
    mime: useMime,
    kind,
    source: 'purchase',
    refType: 'product',
    refId: productId,
    meta
  });
}

function guessMime(name) {
  const ext = path.extname(name || '').toLowerCase();
  for (const [m, e] of Object.entries(MIME_EXT)) if (e === ext) return m;
  if (ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}

module.exports = {
  KINDS, MIME_EXT, ALLOWED_MIME, ALLOWED_EXT, UNSUPPORTED_MSG,
  sha256File, sha256Buffer, absFromUrl, relUrl, safeUnlink, ensureTmpDir,
  isInsideDir,
  usage, assertQuota, addFile, ingestUploads, ingestStickers,
  listAssets, getAsset, deleteAsset, ownsUrl, grantFromProductFile,
  toDto, guessMime
};