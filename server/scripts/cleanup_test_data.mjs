// scripts/cleanup_test_data.mjs
//
// 按**明确的 id / 用户名前缀**彻底清除测试账号：数据库行 + 磁盘上的上传文件。
//
// 背景（ERRORLOG.md → TEST-1）：三个自检脚本原先只释放 IP 绑定、还原角色，
// **不删除自己创建的账号**，于是每跑一轮就沉淀一批 sm_ / sk_ / ric_ 账号
// 及其商品、资源、积分、表情包。渗透测试留下的 sectest_ / massign_ 账号
// （连同 3 把**仍然有效**的 API 密钥）也一直躺在库里。
//
// 安全约束（务必保持）：
//   · 默认**只演练不删除**，必须显式加 --apply；
//   · 永远拒绝删除 id <= 3 的三个真实账号；
//   · 只删「由传入 id 派生出来」的行；文件删除前逐段校验路径，
//     必须落在 uploads/ 之内，杜绝误删 uploads 之外的同前缀目录（§1.19）。
//
// 用法：
//   node scripts/cleanup_test_data.mjs --ids 138,139                 # 演练
//   node scripts/cleanup_test_data.mjs --ids 138,139 --apply         # 真删
//   node scripts/cleanup_test_data.mjs --prefix sm_,sk_,ric_ --apply
//
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'chat.db');
const UPLOAD_ROOT = path.resolve(path.join(HERE, '..', 'uploads'));

// 三个真实账号，任何情况下都不许碰
const PROTECTED_IDS = new Set([1, 2, 3]);

function parseArgs(argv) {
  const out = { ids: [], prefixes: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--ids') out.ids.push(...String(argv[++i] || '').split(',').map((s) => Number(s.trim())).filter(Boolean));
    else if (a === '--prefix') out.prefixes.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** 路径必须落在 uploads/ 内（带分隔符比较 + 逐段拒绝 . / ..） */
function isInsideUploads(abs) {
  const root = UPLOAD_ROOT + path.sep;
  if (!abs.startsWith(root)) return false;
  return !path.relative(UPLOAD_ROOT, abs).split(path.sep).some((s) => s === '..' || s === '.');
}

/** /uploads/xxx → 绝对路径（越界 / 非站内 URL 一律返回 null） */
function absFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const abs = path.resolve(path.join(UPLOAD_ROOT, url.slice('/uploads/'.length)));
  return isInsideUploads(abs) ? abs : null;
}

const args = parseArgs(process.argv.slice(2));
if (args.ids.length === 0 && args.prefixes.length === 0) {
  console.error('用法：node scripts/cleanup_test_data.mjs (--ids 138,139 | --prefix sm_) [--apply]');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH);

// ---------- 选定目标账号 ----------
const all = db.prepare('SELECT id, username, avatar FROM users').all();
const targets = all.filter((u) => {
  if (PROTECTED_IDS.has(u.id)) return false;
  if (args.ids.includes(u.id)) return true;
  return args.prefixes.some((p) => u.username.startsWith(p));
});

if (targets.length === 0) {
  console.log('没有匹配到任何账号，无事可做。');
  db.close();
  process.exit(0);
}

const ids = targets.map((u) => u.id);
const ph = ids.map(() => '?').join(',');
const twice = [...ids, ...ids];

console.log(`${args.apply ? '【真删】' : '【演练】'} 目标账号 ${ids.length} 个：`);
for (const u of targets) console.log(`  · id=${u.id} ${u.username}`);

// ---------- 收集要删的文件 ----------
const fileUrls = new Set();
function addUrl(u) { if (u) fileUrls.add(u); }

for (const u of targets) addUrl(u.avatar);

for (const r of db.prepare(`SELECT file_url AS f, cover_url AS c FROM products WHERE seller_id IN (${ph})`).all(...ids)) {
  addUrl(r.f); addUrl(r.c);
}
for (const r of db.prepare(
  `SELECT pf.file_url AS f FROM product_files pf
    JOIN products p ON p.id = pf.product_id WHERE p.seller_id IN (${ph})`
).all(...ids)) addUrl(r.f);
for (const r of db.prepare(`SELECT url FROM assets WHERE owner_id IN (${ph})`).all(...ids)) addUrl(r.url);
for (const r of db.prepare(`SELECT cover_url AS c FROM sticker_packs WHERE owner_id IN (${ph})`).all(...ids)) addUrl(r.c);
for (const r of db.prepare(
  `SELECT si.url AS u FROM sticker_items si
    JOIN sticker_packs sp ON sp.id = si.pack_id WHERE sp.owner_id IN (${ph})`
).all(...ids)) addUrl(r.u);
for (const r of db.prepare(`SELECT file_url AS f FROM messages WHERE sender_id IN (${ph})`).all(...ids)) addUrl(r.f);
// 群图标：测试账号建的群
for (const r of db.prepare(`SELECT avatar AS a FROM groups WHERE owner_id IN (${ph})`).all(...ids)) addUrl(r.a);
// 聊天背景 / 气泡主题：背景是路径，气泡是 JSON —— 里面同样可能嵌着 /uploads/ 路径
for (const r of db.prepare(`SELECT background AS b, bubble AS j FROM user_preferences WHERE user_id IN (${ph})`).all(...ids)) {
  addUrl(r.b);
  for (const m of String(r.j || '').match(/\/uploads\/[A-Za-z0-9_\-./]+/g) || []) addUrl(m);
}
for (const r of db.prepare(`SELECT background AS b FROM room_preferences WHERE user_id IN (${ph})`).all(...ids)) addUrl(r.b);

const files = [...fileUrls].map(absFromUrl).filter(Boolean).filter((f) => fs.existsSync(f));
console.log(`\n待删文件 ${files.length} 个（uploads/ 内）`);
for (const f of files) console.log(`  - ${path.relative(UPLOAD_ROOT, f)}`);

// ---------- 目标账号拥有的群 ----------
const ownedGroups = db.prepare(`SELECT id FROM groups WHERE owner_id IN (${ph})`).all(...ids).map((g) => g.id);

// ---------- 目标账号参与过的私聊房间 ----------
const privateRooms = new Set();
for (const r of db.prepare(`SELECT DISTINCT room_id AS rid FROM messages WHERE room_type = 'private'`).all()) {
  const parts = String(r.rid).replace(/^p_/, '').split('_').map(Number);
  if (parts.some((p) => ids.includes(p))) privateRooms.add(r.rid);
}

// ---------- 会被删掉的消息 id（先取出来，才能精确清掉它们的已读回执） ----------
const doomedMessages = new Set();
const collect = (sql, params) => { for (const r of db.prepare(sql).all(...params)) doomedMessages.add(r.id); };
collect(`SELECT id FROM messages WHERE sender_id IN (${ph})`, ids);
for (const rid of privateRooms) collect(`SELECT id FROM messages WHERE room_type='private' AND room_id = ?`, [rid]);
for (const g of ownedGroups) collect(`SELECT id FROM messages WHERE room_type='group' AND room_id = ?`, [`g_${g}`]);
const doomedList = [...doomedMessages];
const dph = doomedList.map(() => '?').join(',');

// ---------- 删除计划（表名 → SQL + 参数） ----------
const plan = [];
const push = (label, sql, params) => plan.push({ label, sql, params });

if (ownedGroups.length > 0) {
  const gph = ownedGroups.map(() => '?').join(',');
  push('group_members(owned)', `DELETE FROM group_members WHERE group_id IN (${gph})`, ownedGroups);
  push('group_requests(owned)', `DELETE FROM group_requests WHERE group_id IN (${gph})`, ownedGroups);
  push('messages(owned groups)', `DELETE FROM messages WHERE room_type='group' AND room_id IN (${ownedGroups.map((g) => `'g_${g}'`).join(',')})`, []);
  push('groups(owned)', `DELETE FROM groups WHERE id IN (${gph})`, ownedGroups);
}
if (privateRooms.size > 0) {
  const rph = [...privateRooms].map(() => '?').join(',');
  push('messages(private rooms)', `DELETE FROM messages WHERE room_type='private' AND room_id IN (${rph})`, [...privateRooms]);
}
if (doomedList.length > 0) {
  push('message_reads(doomed msgs)', `DELETE FROM message_reads WHERE message_id IN (${dph})`, doomedList);
}
push('messages(sender)', `DELETE FROM messages WHERE sender_id IN (${ph})`, ids);
push('message_reads', `DELETE FROM message_reads WHERE user_id IN (${ph})`, ids);
push('friendships', `DELETE FROM friendships WHERE user_id IN (${ph}) OR friend_id IN (${ph})`, twice);
push('friend_requests', `DELETE FROM friend_requests WHERE from_id IN (${ph}) OR to_id IN (${ph})`, twice);
push('group_members', `DELETE FROM group_members WHERE user_id IN (${ph})`, ids);
push('group_requests', `DELETE FROM group_requests WHERE user_id IN (${ph})`, ids);
push('user_points', `DELETE FROM user_points WHERE user_id IN (${ph})`, ids);
push('points_transactions', `DELETE FROM points_transactions WHERE user_id IN (${ph})`, ids);
push('product_files', `DELETE FROM product_files WHERE product_id IN (SELECT id FROM products WHERE seller_id IN (${ph}))`, ids);
push('orders', `DELETE FROM orders WHERE buyer_id IN (${ph}) OR seller_id IN (${ph}) OR product_id IN (SELECT id FROM products WHERE seller_id IN (${ph}))`, [...ids, ...ids, ...ids]);
push('products', `DELETE FROM products WHERE seller_id IN (${ph})`, ids);
push('download_logs', `DELETE FROM download_logs WHERE user_id IN (${ph})`, ids);
push('admin_audit', `DELETE FROM admin_audit WHERE actor_id IN (${ph})`, ids);
push('role_requests', `DELETE FROM role_requests WHERE user_id IN (${ph})`, ids);
push('user_preferences', `DELETE FROM user_preferences WHERE user_id IN (${ph})`, ids);
push('room_preferences', `DELETE FROM room_preferences WHERE user_id IN (${ph})`, ids);
push('sticker_items', `DELETE FROM sticker_items WHERE pack_id IN (SELECT id FROM sticker_packs WHERE owner_id IN (${ph}))`, ids);
push('user_sticker_packs', `DELETE FROM user_sticker_packs WHERE user_id IN (${ph}) OR pack_id IN (SELECT id FROM sticker_packs WHERE owner_id IN (${ph}))`, twice);
push('sticker_packs', `DELETE FROM sticker_packs WHERE owner_id IN (${ph})`, ids);
push('assets', `DELETE FROM assets WHERE owner_id IN (${ph})`, ids);
push('api_keys', `DELETE FROM api_keys WHERE user_id IN (${ph})`, ids);
push('apikey_ip_claims', `DELETE FROM apikey_ip_claims WHERE user_id IN (${ph})`, ids);
push('users', `DELETE FROM users WHERE id IN (${ph})`, ids);

console.log('\n删除计划（按顺序执行）：');
for (const step of plan) {
  console.log(`  · ${step.label}（${step.params.length} 个参数）`);
}
console.log(`  · 磁盘文件 ${files.length} 个`);

if (!args.apply) {
  console.log('\n（演练结束，未做任何改动。加 --apply 执行删除。）');
  db.close();
  process.exit(0);
}

// ---------- 真删 ----------
db.exec('BEGIN');
try {
  for (const step of plan) {
    try {
      const info = db.prepare(step.sql).run(...step.params);
      if (info.changes) console.log(`  ✓ ${step.label}: ${info.changes} 行`);
    } catch (err) {
      console.error(`  ✗ ${step.label}: ${err.message}`);
      throw err;
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('已回滚，数据库未改动：', err.message);
  db.close();
  process.exit(1);
}

let removed = 0;
let kept = 0;
// [SEC] 删文件前**再查一遍全库引用**：测试账号的头像 / 封面完全可能同时被「不会跟着删」的行
//       引用 —— 真实事故：公共聊天图标 `room_settings.icon` 指向某个账号的头像，直接删文件
//       就把正在用的图标删坏了（DEVLOG §1.73）。仍被引用的文件一律保留，剩下的交给
//       `cleanup_orphan_files.mjs` 去兜底（那边是全量引用扫描）。
//       [NOTE] 这里动态遍历所有表、从每行 JSON 里抠 /uploads/ 路径，不列字段：列字段一定会漏。
const referencedNow = (() => {
  const out = new Set();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);
  for (const t of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { continue; }
    for (const row of rows) {
      const text = JSON.stringify(row);
      if (!text || !text.includes('/uploads/')) continue;
      for (const m of text.match(/\/uploads\/[A-Za-z0-9_\-./]+/g) || []) {
        out.add(m.replace(/["\\].*$/, ''));
      }
    }
  }
  return out;
})();

for (const f of files) {
  const url = '/uploads/' + path.relative(UPLOAD_ROOT, f).split(path.sep).join('/');
  if (referencedNow.has(url)) {
    kept += 1;
    console.log(`  · 保留（仍被其他行引用）${url}`);
    continue;
  }
  try { fs.unlinkSync(f); removed++; } catch (err) { console.error(`  ✗ 删文件失败 ${f}: ${err.message}`); }
}
// 删掉空的 custom/<uid> 目录
for (const id of ids) {
  const dir = path.join(UPLOAD_ROOT, 'custom', String(id));
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}
console.log(`\n已删除 ${ids.length} 个账号、${removed}/${files.length} 个文件${kept ? `（保留 ${kept} 个仍被引用的）` : ''}。`);
console.log('剩余账号：' + JSON.stringify(db.prepare('SELECT id, username FROM users').all()));
db.close();
