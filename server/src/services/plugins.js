// src/services/plugins.js
//
// 插件系统核心业务。
//
// 【本次改动 · 多页面路由】
//   · manifest 支持 pages 数组：[{ path, title }] 或 ["path"]
//   · entry 字段作为兼容保留：必须出现在 pages 里（通常是 pages[0]）
//   · 若 manifest 没有 pages，自动推导为 [{ path: entry, title: '' }]
//   · 校验：每个 page 的 path 必须在 files 里且以 .html/.htm 结尾
//   · pages 最多 50 个；path 长度 ≤200
//   · parseBundle 里对每个 page 做存在性校验
//
// 【上一轮 · 版本历史】
//   · publish 支持 changelog；上传新版自动归档旧版到 .history/
//   · listVersions / getVersionManifest
//   · publish 后广播 plugin:updated
//
// 【上一轮 · 白名单独立化】
//   · proxy 白名单来自 server/plugin-whitelist.yaml（不再来自 manifest）
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const whitelist = require('./pluginWhitelist');

const CFG = config.PLUGIN_CFG;
const PLUGIN_DIR = config.PLUGIN_DIR;

// ============================================================
// 常量 / 工具
// ============================================================
const ID_RE      = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CODE_LEN   = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PAGES = 50;

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
function notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}
function forbidden(msg) {
  const e = new Error(msg);
  e.status = 403;
  return e;
}

function randomCode(len = CODE_LEN) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (rel.length > 200) return false;
  if (rel.includes('\0')) return false;
  if (path.isAbsolute(rel)) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false;
  const segs = rel.split(/[\\/]+/);
  if (segs.some((s) => s === '..' || s === '.')) return false;
  return true;
}

function insideBundle(bundleDir, absPath) {
  const b = path.resolve(bundleDir);
  const t = path.resolve(absPath);
  return t === b || t.startsWith(b + path.sep);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm'
};

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ============================================================
// 版本比较：语义版本 x.y.z
// ============================================================
function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0.0.0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const dbv = pb[i] || 0;
    if (da > dbv) return 1;
    if (da < dbv) return -1;
  }
  return 0;
}

// ============================================================
// manifest 校验
//
// [CHANGED · 多页面] pages 字段：
//   · 数组，元素可以是 string 或 { path, title }
//   · 至少 1 个页面
//   · 每个 path 必须是 .html/.htm、且是安全相对路径
//   · entry 必须出现在 pages 里（向后兼容：没给 pages 时自动推导）
// ============================================================
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('manifest 必须是对象');
  }

  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) {
    throw fail('manifest.id 不合法：2-32 位，小写字母开头，只含小写字母/数字/连字符');
  }

  const name = String(raw.name || '').trim();
  if (!name || name.length > 40) throw fail('manifest.name 需为 1-40 字符');

  const version = String(raw.version || '').trim();
  if (!VERSION_RE.test(version)) throw fail('manifest.version 需为 x.y.z 格式');

  const description = String(raw.description || '').trim().slice(0, 500);

  // ---------- pages ----------
  const pagesIn = Array.isArray(raw.pages) ? raw.pages : null;
  const pages = [];
  if (pagesIn && pagesIn.length > 0) {
    if (pagesIn.length > MAX_PAGES) throw fail(`页面最多 ${MAX_PAGES} 个`);
    for (const p of pagesIn) {
      if (typeof p === 'string') {
        const relPath = p.trim();
        if (!isSafeRelPath(relPath)) throw fail(`pages 里的路径不合法：${relPath}`);
        if (!/\.html?$/i.test(relPath)) throw fail(`pages 里的路径必须是 .html：${relPath}`);
        pages.push({ path: relPath, title: '' });
      } else if (p && typeof p === 'object') {
        const relPath = String(p.path || '').trim();
        if (!isSafeRelPath(relPath)) throw fail(`pages 里的路径不合法：${relPath}`);
        if (!/\.html?$/i.test(relPath)) throw fail(`pages 里的路径必须是 .html：${relPath}`);
        pages.push({
          path: relPath,
          title: String(p.title || '').trim().slice(0, 40)
        });
      } else {
        throw fail('pages 里的元素必须是字符串或 { path, title }');
      }
    }
    // 去重
    const seen = new Set();
    for (const p of pages) {
      if (seen.has(p.path)) throw fail(`pages 里路径重复：${p.path}`);
      seen.add(p.path);
    }
  }

  // ---------- entry（兼容字段） ----------
  const entry = String(raw.entry || '').trim();
  if (!isSafeRelPath(entry)) throw fail('manifest.entry 不合法（相对路径、不允许 ..）');
  if (!/\.html?$/i.test(entry)) throw fail('manifest.entry 必须是 .html 文件');

  // 没给 pages → 用 entry 推导
  if (pages.length === 0) {
    pages.push({ path: entry, title: '' });
  }
  // entry 必须出现在 pages 里
  if (!pages.some((p) => p.path === entry)) {
    throw fail(`manifest.entry「${entry}」必须出现在 pages 列表里`);
  }

  // ---------- permissions ----------
  const permsRaw = Array.isArray(raw.permissions) ? raw.permissions : [];
  const permissions = [];
  for (const p of permsRaw) {
    const s = String(p || '').trim();
    if (!CFG.allowed_permissions.has(s)) {
      throw fail(`未知权限：${s}（不在白名单内）`);
    }
    if (!permissions.includes(s)) permissions.push(s);
  }
  if (permissions.length > 20) throw fail('权限最多 20 项');

  // ---------- maxPayment ----------
  let maxPayment = null;
  if (raw.maxPayment !== undefined && raw.maxPayment !== null) {
    const n = Number(raw.maxPayment);
    if (!Number.isInteger(n) || n <= 0) throw fail('manifest.maxPayment 必须是正整数');
    if (n > CFG.payment.max_single) {
      throw fail(`manifest.maxPayment 不能超过 ${CFG.payment.max_single}`);
    }
    maxPayment = n;
  }

  const out = { id, name, version, entry, description, permissions, pages };
  if (maxPayment !== null) out.maxPayment = maxPayment;
  // 可选 compatibility：透传（当前不强制校验）
  if (raw.compatibility && typeof raw.compatibility === 'object') {
    out.compatibility = {
      hostFeatures: Array.isArray(raw.compatibility.hostFeatures)
        ? raw.compatibility.hostFeatures.map(String).slice(0, 20)
        : [],
      minHostVersion: Number(raw.compatibility.minHostVersion) || 1
    };
  }
  return out;
}

// ============================================================
// 包解包 / 落盘
// ============================================================
function parseBundle(buf) {
  if (buf.length > CFG.max_bundle_bytes) {
    throw fail(`插件包不能超过 ${Math.round(CFG.max_bundle_bytes / 1048576)}MB`);
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw fail('插件包不是合法 JSON（.plugin 格式见文档）');
  }
  if (!parsed || typeof parsed !== 'object') throw fail('插件包结构错误');
  const manifest = normalizeManifest(parsed.manifest);
  const filesIn = parsed.files;
  if (!filesIn || typeof filesIn !== 'object' || Array.isArray(filesIn)) {
    throw fail('插件包缺少 files 字段');
  }
  const keys = Object.keys(filesIn);
  if (keys.length === 0) throw fail('插件包里没有文件');
  if (keys.length > CFG.max_files_per_plugin) {
    throw fail(`插件最多 ${CFG.max_files_per_plugin} 个文件`);
  }

  const files = {};
  for (const rel of keys) {
    if (!isSafeRelPath(rel)) throw fail(`文件路径不合法：${rel}`);
    const content = filesIn[rel];
    if (typeof content !== 'string') throw fail(`文件内容必须是字符串：${rel}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > CFG.max_file_bytes) {
      throw fail(`单文件不能超过 ${Math.round(CFG.max_file_bytes / 1024)}KB：${rel}`);
    }
    files[rel] = content;
  }

  // [CHANGED · 多页面] 所有 page 的 path 都必须在 files 里
  for (const p of manifest.pages) {
    if (!(p.path in files)) {
      throw fail(`manifest.pages 里的「${p.path}」不在 files 里`);
    }
  }
  // entry 兼容校验（老逻辑：entry 必须在 files 里）
  if (!(manifest.entry in files)) {
    throw fail(`manifest.entry「${manifest.entry}」不在 files 里`);
  }

  return { manifest, files };
}

/** 把插件文件写入指定目录（路径逐段校验，防越界） */
function writeBundleTo(dir, files) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });

  for (const rel of Object.keys(files)) {
    const segs = rel.split(/[\\/]+/);
    const last = segs.pop();
    let cur = dir;
    for (const s of segs) {
      cur = path.join(cur, s);
      if (!insideBundle(dir, cur)) throw fail(`路径越界：${rel}`);
      if (!fs.existsSync(cur)) fs.mkdirSync(cur);
    }
    const abs = path.join(cur, last);
    if (!insideBundle(dir, abs)) throw fail(`路径越界：${rel}`);
    fs.writeFileSync(abs, files[rel], 'utf8');
  }

  return dir;
}

// ============================================================
// 版本归档
// ============================================================
const HISTORY_DIRNAME = '.history';

function historyDirFor(pluginId, version) {
  return path.join(PLUGIN_DIR, HISTORY_DIRNAME, pluginId, version);
}

function archiveVersion(row) {
  const histDir = historyDirFor(row.id, row.version);
  if (!fs.existsSync(histDir)) {
    fs.mkdirSync(path.dirname(histDir), { recursive: true });
    fs.cpSync(row.bundle_dir, histDir, { recursive: true });
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO plugin_versions
         (plugin_id, version, bundle_dir, manifest, changelog, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id, row.version, histDir,
      row.manifest, null,
      row.owner_id, row.updated_at || Date.now()
    );
  } catch (err) {
    console.error('[plugins] 归档版本失败:', err.message);
  }
}

// ============================================================
// DTO
// ============================================================
function toDto(row, extra = {}) {
  if (!row) return null;
  let manifest = null;
  try { manifest = JSON.parse(row.manifest); } catch { manifest = null; }
  let permissions = [];
  try { permissions = JSON.parse(row.permissions); } catch { permissions = []; }

  // [NEW] 从 manifest 提取 pages（老库里的 manifest 可能没有 pages，
  //       这时用 entry 推导一个单页）
  let pages = null;
  if (manifest && Array.isArray(manifest.pages) && manifest.pages.length > 0) {
    pages = manifest.pages.map((p) => ({ path: p.path, title: p.title || '' }));
  } else {
    pages = [{ path: row.entry, title: '' }];
  }

  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    version: row.version,
    description: row.description || '',
    iconUrl: row.icon_url || null,
    entry: row.entry,
    pages,
    permissions,
    proxy: whitelist.getAllowList(row.id),
    isPublic: !!row.is_public,
    shareCode: row.is_public ? (row.share_code || null) : null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    manifest,
    ...extra
  };
}

// ============================================================
// 上传 / 发布 / 更新
// ============================================================
function publish({ ownerId, buf, isPublic = false, iconUrl = null, changelog = '' }) {
  const { manifest, files } = parseBundle(buf);

  const existing = db.prepare('SELECT * FROM plugins WHERE id = ?').get(manifest.id);
  if (existing && existing.owner_id !== ownerId) {
    throw forbidden('该插件 ID 已被其他用户占用');
  }
  if (existing && (existing.status === 'delisted' || existing.status === 'hidden')) {
    throw forbidden(
      existing.status === 'delisted'
        ? '该插件已被管理员下架，不能重新发布（需管理员恢复）'
        : '该插件已被管理员隐藏，不能重新发布（需管理员恢复）'
    );
  }
  if (existing && compareVersions(manifest.version, existing.version) < 0) {
    throw fail(
      `新版本号 ${manifest.version} 低于当前版本 ${existing.version}；`
      + '如需回退请联系管理员'
    );
  }

  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM plugins WHERE owner_id = ?')
      .get(ownerId).c;
    if (count >= CFG.max_published_per_user) {
      throw fail(`最多发布 ${CFG.max_published_per_user} 个插件`);
    }
  }

  const finalDir = path.join(PLUGIN_DIR, manifest.id);
  const tmpDir = path.join(PLUGIN_DIR, `.tmp-${manifest.id}-${crypto.randomBytes(4).toString('hex')}`);
  const bundleDir = finalDir;
  const now = Date.now();

  try {
    writeBundleTo(tmpDir, files);

    if (existing) {
      archiveVersion(existing);
      if (changelog && String(changelog).trim()) {
        try {
          db.prepare(
            `UPDATE plugin_versions SET changelog = ?
              WHERE plugin_id = ? AND version = ?`
          ).run(String(changelog).slice(0, 2000), existing.id, existing.version);
        } catch { /* ignore */ }
      }
    }

    if (existing) {
      db.prepare(
        `UPDATE plugins SET
          name = ?, version = ?, description = ?, icon_url = ?,
          manifest = ?, entry = ?, bundle_dir = ?, permissions = ?,
          is_public = ?, status = 'active', updated_at = ?
        WHERE id = ?`
      ).run(
        manifest.name, manifest.version, manifest.description, iconUrl,
        JSON.stringify(manifest), manifest.entry, bundleDir, JSON.stringify(manifest.permissions),
        isPublic ? 1 : existing.is_public, now, manifest.id
      );
    } else {
      db.prepare(
        `INSERT INTO plugins
          (id, owner_id, name, version, description, icon_url, manifest, entry,
           bundle_dir, permissions, is_public, share_code, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`
      ).run(
        manifest.id, ownerId, manifest.name, manifest.version, manifest.description, iconUrl,
        JSON.stringify(manifest), manifest.entry, bundleDir, JSON.stringify(manifest.permissions),
        isPublic ? 1 : 0, now, now
      );
    }

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  // 广播更新
  if (existing) {
    try {
      const registry = require('../socket/registry');
      const installedUsers = db.prepare(
        'SELECT user_id FROM user_plugins WHERE plugin_id = ?'
      ).all(manifest.id);
      for (const u of installedUsers) {
        registry.sendTo(u.user_id, 'plugin:updated', {
          pluginId: manifest.id,
          name: manifest.name,
          oldVersion: existing.version,
          newVersion: manifest.version,
          changelog: changelog || ''
        });
      }
    } catch (err) {
      console.error('[plugins] 广播 plugin:updated 失败:', err.message);
    }
  }

  return getById(manifest.id, ownerId);
}

// ============================================================
// 查询
// ============================================================
function getById(id, viewerId = null) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!row) return null;

  const installed = viewerId
    ? !!db.prepare('SELECT 1 FROM user_plugins WHERE user_id = ? AND plugin_id = ?').get(viewerId, id)
    : false;
  const isOwner = viewerId === row.owner_id;

  let grantedPerms = null;
  if (installed) {
    const u = db.prepare('SELECT granted_perms FROM user_plugins WHERE user_id = ? AND plugin_id = ?')
      .get(viewerId, id);
    try { grantedPerms = JSON.parse(u.granted_perms); } catch { grantedPerms = []; }
  }

  return toDto(row, { installed, isOwner, grantedPerms });
}

function listAll(viewerId, { scope = 'all', keyword = '' } = {}) {
  const kw = String(keyword || '').trim();
  const like = kw ? `%${kw}%` : null;

  const installedIds = db.prepare('SELECT plugin_id FROM user_plugins WHERE user_id = ?')
    .all(viewerId).map((r) => r.plugin_id);

  if (scope === 'installed') {
    if (installedIds.length === 0) return [];
    const ph = installedIds.map(() => '?').join(',');
    const rows = like
      ? db.prepare(`SELECT * FROM plugins WHERE id IN (${ph}) AND (instr(name, ?) > 0 OR instr(id, ?) > 0)`).all(...installedIds, kw, kw)
      : db.prepare(`SELECT * FROM plugins WHERE id IN (${ph})`).all(...installedIds);
    return rows.map((r) => toDto(r, {
      installed: true,
      isOwner: r.owner_id === viewerId
    }));
  }

  if (scope === 'mine') {
    const rows = like
      ? db.prepare(`SELECT * FROM plugins WHERE owner_id = ? AND (instr(name, ?) > 0 OR instr(id, ?) > 0) ORDER BY updated_at DESC`).all(viewerId, kw, kw)
      : db.prepare(`SELECT * FROM plugins WHERE owner_id = ? ORDER BY updated_at DESC`).all(viewerId);
    return rows.map((r) => toDto(r, {
      installed: installedIds.includes(r.id),
      isOwner: true
    }));
  }

  const rows = like
    ? db.prepare(
        `SELECT * FROM plugins
         WHERE ((status = 'active' AND is_public = 1)
             OR owner_id = ?
             OR id IN (${installedIds.length ? installedIds.map(() => '?').join(',') : 'NULL'}))
           AND (instr(name, ?) > 0 OR instr(id, ?) > 0)
         ORDER BY updated_at DESC
         LIMIT 200`
      ).all(viewerId, ...installedIds, kw, kw)
    : db.prepare(
        `SELECT * FROM plugins
         WHERE (status = 'active' AND is_public = 1)
            OR owner_id = ?
            OR id IN (${installedIds.length ? installedIds.map(() => '?').join(',') : 'NULL'})
         ORDER BY updated_at DESC
         LIMIT 200`
      ).all(viewerId, ...installedIds);

  return rows.map((r) => toDto(r, {
    installed: installedIds.includes(r.id),
    isOwner: r.owner_id === viewerId
  }));
}

function listForAdmin({
  status = null,
  keyword = '',
  ownerId = null,
  limit = 100,
  offset = 0
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const kw = String(keyword || '').trim();

  const where = [];
  const args = [];

  if (status) {
    where.push('p.status = ?');
    args.push(String(status));
  }
  if (ownerId != null) {
    where.push('p.owner_id = ?');
    args.push(Number(ownerId));
  }
  if (kw) {
    where.push('(instr(p.name, ?) > 0 OR instr(p.id, ?) > 0)');
    args.push(kw, kw);
  }

  const sql = `
    SELECT p.*,
           u.nickname AS ownerName, u.username AS ownerUsername,
           (SELECT COUNT(*) FROM user_plugins up WHERE up.plugin_id = p.id) AS installCount
      FROM plugins p
      LEFT JOIN users u ON u.id = p.owner_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.updated_at DESC
     LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...args, lim, off);

  return rows.map((r) => toDto(r, {
    ownerName: r.ownerName || `#${r.owner_id}`,
    ownerUsername: r.ownerUsername || '',
    installCount: r.installCount || 0
  }));
}

function adminStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                AS total,
      COUNT(*) FILTER (WHERE status = 'active')               AS active,
      COUNT(*) FILTER (WHERE status = 'hidden')               AS hidden,
      COUNT(*) FILTER (WHERE status = 'delisted')             AS delisted,
      COUNT(*) FILTER (WHERE is_public = 1)                   AS publicCount
    FROM plugins
  `).get();
  const inst = db.prepare('SELECT COUNT(*) AS c FROM user_plugins').get();
  const payRow = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'paid')                  AS paidCount,
      COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)  AS paidSum
    FROM plugin_payments
  `).get();
  return {
    total: row.total || 0,
    active: row.active || 0,
    hidden: row.hidden || 0,
    delisted: row.delisted || 0,
    publicCount: row.publicCount || 0,
    installTotal: inst.c || 0,
    paidCount: payRow.paidCount || 0,
    paidSum: payRow.paidSum || 0
  };
}

// ============================================================
// 版本历史
// ============================================================
function listVersions(pluginId) {
  const rows = db.prepare(
    `SELECT id, plugin_id AS pluginId, version, changelog,
            uploaded_by AS uploadedBy, uploaded_at AS uploadedAt
       FROM plugin_versions WHERE plugin_id = ?
       ORDER BY uploaded_at DESC`
  ).all(pluginId);
  return rows;
}

function getVersionManifest(pluginId, version) {
  const row = db.prepare(
    'SELECT manifest FROM plugin_versions WHERE plugin_id = ? AND version = ?'
  ).get(pluginId, version);
  if (!row) return null;
  try { return JSON.parse(row.manifest); } catch { return null; }
}

// ============================================================
// 安装 / 卸载
// ============================================================
function install(userId, pluginId, grantedPerms) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status !== 'active') throw fail('插件已下架');
  if (row.owner_id !== userId && !row.is_public) throw forbidden('该插件未公开，无法安装');

  const existing = db.prepare('SELECT 1 FROM user_plugins WHERE user_id = ? AND plugin_id = ?')
    .get(userId, pluginId);
  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM user_plugins WHERE user_id = ?').get(userId).c;
    if (count >= CFG.max_installed_per_user) {
      throw fail(`最多安装 ${CFG.max_installed_per_user} 个插件`);
    }
  }

  let declared = [];
  try { declared = JSON.parse(row.permissions); } catch { declared = []; }
  const declaredSet = new Set(declared);
  const granted = Array.isArray(grantedPerms) ? grantedPerms.map(String) : [];
  for (const p of granted) {
    if (!declaredSet.has(p)) throw fail(`无法授权未声明的权限：${p}`);
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO user_plugins (user_id, plugin_id, installed_at, granted_perms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, plugin_id) DO UPDATE SET
       granted_perms = excluded.granted_perms`
  ).run(userId, pluginId, now, JSON.stringify(granted));

  return getById(pluginId, userId);
}

function uninstall(userId, pluginId) {
  const row = db.prepare('SELECT owner_id FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');

  db.prepare('DELETE FROM user_plugins WHERE user_id = ? AND plugin_id = ?').run(userId, pluginId);
  db.prepare('DELETE FROM plugin_kv WHERE user_id = ? AND plugin_id = ?').run(userId, pluginId);
  return { ok: true };
}

// ============================================================
// 分享 / 订阅
// ============================================================
function share(userId, pluginId, regenerate = false) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.owner_id !== userId) throw forbidden('只有作者可以分享');

  let code = row.share_code;
  if (!code || regenerate) {
    code = 'PLG-' + randomCode();
    let guard = 0;
    while (db.prepare('SELECT 1 FROM plugins WHERE share_code = ? AND id != ?').get(code, pluginId) && guard++ < 10) {
      code = 'PLG-' + randomCode();
    }
  }
  db.prepare('UPDATE plugins SET is_public = 1, share_code = ?, updated_at = ? WHERE id = ?')
    .run(code, Date.now(), pluginId);

  return { pluginId, shareCode: code, isPublic: true };
}

function setPrivate(userId, pluginId) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.owner_id !== userId) throw forbidden('只有作者可以修改');
  db.prepare('UPDATE plugins SET is_public = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), pluginId);
  return getById(pluginId, userId);
}

function subscribe(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw fail('请输入分享码');
  const row = db.prepare('SELECT * FROM plugins WHERE share_code = ?').get(code);
  if (!row) throw fail('分享码无效');
  if (row.status !== 'active') throw fail('插件已下架');
  if (!row.is_public) throw fail('该插件未公开分享');
  return install(userId, row.id, []);
}

// ============================================================
// 入口 / 资源
// ============================================================
function resolveEntry(userId, pluginId) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status !== 'active') throw fail('插件已下架', 403);

  const installed = !!db.prepare('SELECT 1 FROM user_plugins WHERE user_id = ? AND plugin_id = ?')
    .get(userId, pluginId);
  if (!installed && row.owner_id !== userId) throw forbidden('未安装该插件');

  const bundleDir = row.bundle_dir;
  const entry = row.entry;
  if (!isSafeRelPath(entry)) throw fail('插件入口路径异常');
  const abs = path.resolve(path.join(bundleDir, entry));
  if (!insideBundle(bundleDir, abs)) throw fail('插件入口路径越界');
  if (!fs.existsSync(abs)) throw notFound('插件入口文件缺失');
  return abs;
}

function resolveAsset(userId, pluginId, relPath) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status !== 'active') throw fail('插件已下架', 403);

  const installed = !!db.prepare('SELECT 1 FROM user_plugins WHERE user_id = ? AND plugin_id = ?')
    .get(userId, pluginId);
  if (!installed && row.owner_id !== userId) throw forbidden('未安装该插件');

  if (!isSafeRelPath(relPath)) throw fail('资源路径不合法');
  const abs = path.resolve(path.join(row.bundle_dir, relPath));
  if (!insideBundle(row.bundle_dir, abs)) throw fail('资源路径越界');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw notFound('资源不存在');
  return abs;
}

// ============================================================
// KV 存储
// ============================================================
function kvList(pluginId, userId) {
  const rows = db.prepare(
    'SELECT key, value, updated_at FROM plugin_kv WHERE plugin_id = ? AND user_id = ? ORDER BY key'
  ).all(pluginId, userId);
  return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
}

function kvGet(pluginId, userId, key) {
  if (typeof key !== 'string' || !key || key.length > 128) throw fail('key 不合法');
  const row = db.prepare(
    'SELECT value FROM plugin_kv WHERE plugin_id = ? AND user_id = ? AND key = ?'
  ).get(pluginId, userId, key);
  return row ? row.value : null;
}

function kvSet(pluginId, userId, key, value) {
  if (typeof key !== 'string' || !key || key.length > 128) throw fail('key 不合法');
  const val = String(value);
  if (Buffer.byteLength(val, 'utf8') > CFG.kv_value_max_bytes) {
    throw fail(`value 超过 ${CFG.kv_value_max_bytes} 字节`);
  }

  const existing = db.prepare(
    'SELECT value FROM plugin_kv WHERE plugin_id = ? AND user_id = ? AND key = ?'
  ).get(pluginId, userId, key);
  const oldLen = existing ? Buffer.byteLength(existing.value, 'utf8') : 0;
  const usedRow = db.prepare(
    `SELECT COALESCE(SUM(length(value)), 0) AS used
       FROM plugin_kv WHERE plugin_id = ? AND user_id = ?`
  ).get(pluginId, userId);
  const newUsed = usedRow.used - oldLen + Buffer.byteLength(val, 'utf8');
  if (newUsed > CFG.kv_quota_bytes) {
    throw fail(`插件存储配额不足（${CFG.kv_quota_bytes} 字节）`);
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO plugin_kv (plugin_id, user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, user_id, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at`
  ).run(pluginId, userId, key, val, now);

  return { key, value: val, updatedAt: now };
}

function kvDel(pluginId, userId, key) {
  if (typeof key !== 'string' || !key) throw fail('key 不合法');
  const info = db.prepare(
    'DELETE FROM plugin_kv WHERE plugin_id = ? AND user_id = ? AND key = ?'
  ).run(pluginId, userId, key);
  return { removed: info.changes > 0 };
}

function kvUsage(pluginId, userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(length(value)), 0) AS used, COUNT(*) AS cnt
       FROM plugin_kv WHERE plugin_id = ? AND user_id = ?`
  ).get(pluginId, userId);
  return { used: row.used, count: row.cnt, quota: CFG.kv_quota_bytes };
}

// ============================================================
// 权限
// ============================================================
function grantedPermSet(userId, pluginId) {
  const row = db.prepare(
    'SELECT granted_perms FROM user_plugins WHERE user_id = ? AND plugin_id = ?'
  ).get(userId, pluginId);
  if (!row) return new Set();
  try { return new Set(JSON.parse(row.granted_perms)); } catch { return new Set(); }
}

function isInstalled(userId, pluginId) {
  return !!db.prepare('SELECT 1 FROM user_plugins WHERE user_id = ? AND plugin_id = ?')
    .get(userId, pluginId);
}

// ============================================================
// 删除 / 管理
// ============================================================
function delist(pluginId, actorId, actorRole, reason) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status === 'delisted') throw fail('插件已下架');

  db.prepare("UPDATE plugins SET status = 'delisted', updated_at = ? WHERE id = ?")
    .run(Date.now(), pluginId);

  const { audit } = require('./permissions');
  audit(actorId, actorRole, 'delist', 'plugin', 0, `${pluginId}：${reason || '管理员下架'}`);
  return { ok: true };
}

function restore(pluginId, actorId, actorRole) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status === 'active') throw fail('插件已是正常状态');

  db.prepare("UPDATE plugins SET status = 'active', updated_at = ? WHERE id = ?")
    .run(Date.now(), pluginId);

  const { audit } = require('./permissions');
  audit(actorId, actorRole, 'restore_plugin', 'plugin', 0, pluginId);
  return { ok: true };
}

function hide(pluginId, actorId, actorRole, reason) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.status === 'hidden') throw fail('插件已被隐藏');
  if (row.status === 'delisted') throw fail('已下架的插件不能改为隐藏');

  db.prepare("UPDATE plugins SET status = 'hidden', updated_at = ? WHERE id = ?")
    .run(Date.now(), pluginId);

  const { audit } = require('./permissions');
  audit(actorId, actorRole, 'hide_plugin', 'plugin', 0,
        `${pluginId}：${reason || '管理员隐藏'}`);
  return { ok: true };
}

function removeById(userId, pluginId) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw notFound('插件不存在');
  if (row.owner_id !== userId) throw forbidden('只有作者可以删除');

  db.prepare('DELETE FROM user_plugins WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_kv WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugin_versions WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM plugins WHERE id = ?').run(pluginId);

  try {
    const dir = path.join(PLUGIN_DIR, pluginId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    const hist = path.join(PLUGIN_DIR, HISTORY_DIRNAME, pluginId);
    if (fs.existsSync(hist)) fs.rmSync(hist, { recursive: true, force: true });
  } catch { /* ignore */ }

  return { ok: true };
}

module.exports = {
  ID_RE, VERSION_RE,

  publish, parseBundle, normalizeManifest, compareVersions,

  getById, listAll, listForAdmin, adminStats,

  listVersions, getVersionManifest,

  install, uninstall, isInstalled,

  share, setPrivate, subscribe,

  resolveEntry, resolveAsset, mimeOf,

  kvList, kvGet, kvSet, kvDel, kvUsage,

  grantedPermSet,

  delist, restore, hide, removeById
};