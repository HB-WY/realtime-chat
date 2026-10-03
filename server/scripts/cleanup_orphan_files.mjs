// scripts/cleanup_orphan_files.mjs
//
// 孤儿上传文件清理：删掉 uploads/ 里**没有任何库内引用**的文件。
//
// 为什么需要它：`cleanup_test_data.mjs` 只删「从目标账号的行里收集到」的文件，
// 而**没挂到任何消息上**的测试上传（例如 smoke_test 上传后没发送的附件、资源池
// 上传中途失败留下的 uploads/tmp/*）不属于任何行，会一直躺在磁盘上。
//
// [SEC] 引用面必须**穷举**，所以这里不列字段：动态遍历 sqlite_master 里的所有表，
//       把每一行 JSON 里的 /uploads/ 路径全抠出来当引用 —— 包括 room_settings.icon、
//       user_preferences.background、bubble 主题 JSON 这类「藏在文本里的路径」。
//       手工列字段一定会漏（真实教训：漏了 room_settings.icon，把正在用的公共聊天
//       图标当孤儿删了，见 DEVLOG §1.73）。
//
// 安全约束：
//   · 默认**只演练**，必须显式 --apply 才删；
//   · 只处理 uploads/ 根目录**之内**的文件，且不动 .gitkeep；
//   · 删除前重新查一遍引用（防并发写入），仍被引用的文件一律保留。
//
// 用法：
//   node scripts/cleanup_orphan_files.mjs            # 演练
//   node scripts/cleanup_orphan_files.mjs --apply    # 真删
//
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const UPLOAD_ROOT = path.resolve(path.join(ROOT, 'uploads'));
const APPLY = process.argv.includes('--apply');

const URL_RE = /\/uploads\/[A-Za-z0-9_\-./]+/g;

/** 遍历库里所有表的所有行，抠出全部 /uploads/ 引用 */
function collectReferences() {
  const db = new DatabaseSync(path.join(ROOT, 'chat.db'), { readOnly: true });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);

  const refs = new Map(); // url -> Set('table#id')
  for (const t of tables) {
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM "${t}"`).all();
    } catch {
      continue; // 视图 / 虚拟表之类读不了就跳过
    }
    for (const row of rows) {
      const text = JSON.stringify(row);
      if (!text || !text.includes('/uploads/')) continue;
      for (const m of text.match(URL_RE) || []) {
        // JSON 转义后的截断：路径里不会出现引号或反斜杠，直接取到结尾即可
        const url = m.replace(/["\\].*$/, '');
        if (!refs.has(url)) refs.set(url, new Set());
        refs.get(url).add(`${t}#${row.id ?? row.room_key ?? row.user_id ?? '?'}`);
      }
    }
  }
  db.close();
  return refs;
}

function urlOf(abs) {
  return '/uploads/' + path.relative(UPLOAD_ROOT, abs).split(path.sep).join('/');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!e.name.endsWith('.gitkeep')) out.push(p);
  }
  return out;
}

if (!fs.existsSync(UPLOAD_ROOT)) {
  console.error(`找不到上传目录：${UPLOAD_ROOT}`);
  process.exit(2);
}

const refs = collectReferences();
const files = walk(UPLOAD_ROOT).filter((p) => p.startsWith(UPLOAD_ROOT + path.sep));
const orphans = files.filter((p) => !refs.has(urlOf(p)));

// [SEC] 最近改动过的文件一概不碰。
// 为什么必须熔断：使用者可能**正在用这个应用** —— 附件传上去了、还没点发送，
// 从库里看它「无引用」，但它不是垃圾（真实撞到过：一个 127KB 的 webp 刚传进
// uploads/files 还没发出去，正好落在一次清理的窗口里）。默认 1 小时，
// 要清更近的显式加 `--min-age-minutes=0`。
const MIN_AGE_MIN = (() => {
  const hit = process.argv.find((a) => a.startsWith('--min-age-minutes='));
  if (hit) return Math.max(0, Number(hit.split('=')[1]) || 0);
  return 60;
})();
const ageMinutes = (p) => (Date.now() - fs.statSync(p).mtimeMs) / 60000;

const fresh = orphans.filter((p) => ageMinutes(p) < MIN_AGE_MIN);
const stale = orphans.filter((p) => ageMinutes(p) >= MIN_AGE_MIN);

console.log(`uploads/ 内文件 ${files.length} 个，库内引用 ${refs.size} 个`);
console.log(`\n${APPLY ? '【真删】' : '【演练】'}无引用（孤儿）文件 ${orphans.length} 个`
  + `（其中 ${fresh.length} 个是最近 ${MIN_AGE_MIN} 分钟内动过的，一律跳过）：`);
for (const p of orphans) {
  const mark = ageMinutes(p) < MIN_AGE_MIN ? '⏳ 太新，跳过' : '可删';
  console.log(`  - [${mark}] ${urlOf(p)}（${fs.statSync(p).size} B，${ageMinutes(p).toFixed(0)} 分钟前）`);
}

if (!APPLY) {
  console.log('\n（演练结束，未做任何改动。加 --apply 执行删除。）');
  process.exit(0);
}

// 删除前**再查一遍引用**（期间有新写入就留下），并且只删「够旧」的那批
const freshRefs = collectReferences();
let removed = 0;
let kept = fresh.length;
for (const p of stale) {
  const url = urlOf(p);
  if (freshRefs.has(url)) {
    kept += 1;
    console.log(`  · 保留（刚刚被引用）${url} ← ${[...freshRefs.get(url)].join(', ')}`);
    continue;
  }
  try {
    fs.unlinkSync(p);
    removed += 1;
  } catch (err) {
    console.error(`  ✗ 删除失败 ${url}: ${err.message}`);
  }
}

// 清掉空目录（只删空的）
for (const dir of [path.join(UPLOAD_ROOT, 'custom'), path.join(UPLOAD_ROOT, 'tmp')]) {
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    try {
      if (fs.readdirSync(p).length === 0) { fs.rmdirSync(p); console.log(`  · 已删空目录 ${urlOf(p)}`); }
    } catch { /* ignore */ }
  }
}

console.log(`\n已删除 ${removed} 个孤儿文件${kept ? `，保留 ${kept} 个（仍被引用 / 太新）` : ''}。`);
console.log(`剩余：${collectReferences().size} 个引用 / ${walk(UPLOAD_ROOT).length} 个文件。`);
