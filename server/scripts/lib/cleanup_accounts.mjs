// scripts/lib/cleanup_accounts.mjs
//
// 自检脚本的**统一收尾**：把本套测试账号从真实库里彻底删掉。
//
// 为什么必须有这一步（ERRORLOG TEST-1）：`test:api` / `test:socket` / `test:room-icon`
// 都打在**真实 `chat.db`** 上，而历史上收尾只「释放 IP 绑定 + 还原角色」，
// 账号本身与它名下的消息 / 群 / 商品 / 资源 / 上传文件会一轮一轮沉淀下来 ——
// 本轮实测两轮就留下 11 个账号 + 64 个无引用文件（DEVLOG §1.74）。
//
// 复用已审查过的 `cleanup_test_data.mjs`（默认演练、永远拒绝 id ≤ 3、
// 路径逐段校验、删文件前复查全库引用），这里只负责把 id 递过去、把输出收敛成一行。
//
// 想保留现场（排查用）：给自检脚本加 `--keep`。
//
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEANUP_SCRIPT = path.join(HERE, '..', 'cleanup_test_data.mjs');
const SERVER_ROOT = path.join(HERE, '..', '..');
const UPLOAD_ROOT = path.join(SERVER_ROOT, 'uploads');

/** 自检脚本是否要求保留测试账号（--keep） */
export function keepTestAccounts() {
  return process.argv.includes('--keep');
}

/**
 * 删除本套测试账号及其名下数据与上传文件。
 * @param {Array<number|undefined|null>} ids 本套脚本创建的账号 id
 * @returns {{skipped?:boolean, ok?:boolean, ids?:number[]}}
 */
export function cleanupTestAccounts(ids, { keep = keepTestAccounts() } = {}) {
  // id ≤ 3 是三个真实账号，绝不允许出现在这里（cleanup_test_data 也会再拒一次）
  const list = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 3))];
  if (list.length === 0) return { skipped: true };

  if (keep) {
    console.log(`\x1b[90m（--keep：保留本套测试账号 ${list.join(', ')} 未清理；收尾请跑 npm run cleanup:test-data -- --ids ${list.join(',')} --apply）\x1b[0m`);
    return { skipped: true };
  }

  const r = spawnSync(process.execPath, [CLEANUP_SCRIPT, '--ids', list.join(','), '--apply'], {
    encoding: 'utf8',
    windowsHide: true
  });

  if (r.status === 0) {
    console.log(`\x1b[90m收尾：已删除本套测试账号 ${list.join(', ')}（含名下数据与上传文件）\x1b[0m`);
    return { ok: true, ids: list };
  }

  console.log(
    `\x1b[31m收尾失败（退出码 ${r.status}）：请手动执行 `
    + `node scripts/cleanup_test_data.mjs --ids ${list.join(',')} --apply\x1b[0m`
  );
  const detail = (r.stderr || r.stdout || '').trim();
  if (detail) console.error(detail.split('\n').slice(-6).join('\n'));
  return { ok: false, ids: list };
}

// ============================================================
// 本次运行产生的上传文件
// ============================================================
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 跑之前调用一次：记下 uploads/ 里现有的文件 */
export function snapshotUploads() {
  if (!fs.existsSync(UPLOAD_ROOT)) return new Set();
  return new Set(walk(UPLOAD_ROOT));
}

/** 库里所有 /uploads/ 引用（动态穷举所有表 + 每行 JSON 里的路径，同 cleanup_orphan_files.mjs 的口径） */
function collectReferencedUrls() {
  const db = new DatabaseSync(path.join(SERVER_ROOT, 'chat.db'), { readOnly: true });
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
  db.close();
  return out;
}

/**
 * 删掉**本次自检新产生、且没有任何库内引用**的上传文件。
 *
 * 为什么不是直接跑 `cleanup_orphan_files.mjs`：那是**全局**清理，会把使用者自己
 * 「传了但没发出去」的历史残留一起删掉。这里只认 `before` 快照之外的新文件，
 * 影响面严格限定在本套自检这一次运行。
 *
 * 典型残留：smoke_test 的上传用例（4 个附件 + 1 个资源池临时图）里有几个从没被
 * 发成消息，账号删掉后它们就成了无主文件（DEVLOG §1.74）。
 *
 * [SEC] 关于「用户正在使用」的年龄熔断：
 *   `before` 快照已经限定了**只清理本次自检期间新增的文件**，
 *   所以这里**默认不做 mtime 熔断** —— 跑自检时通常会先停掉应用或空闲，
 *   且 `before` 已经排除了「自检开始前就已经在传的文件」。
 *
 *   如果担心「用户恰好在自检期间上传、且还没点发送」这个低概率场景，
 *   把 `minAgeMs` 传成 `60 * 60 * 1000` 打开 1 小时熔断 —— 代价是本次
 *   自检自己上传的文件也会被保留下来（< 1 小时），需要事后跑
 *   `npm run cleanup:orphans` 兜底。
 *
 * @param {Set<string>} before           snapshotUploads() 的返回值
 * @param {object}     [opts]
 * @param {boolean}    [opts.keep]       同 keepTestAccounts
 * @param {number}     [opts.minAgeMs]   年龄熔断毫秒；默认 0（不启用）
 * @returns {{skipped?:boolean, removed?:number, kept?:number, skippedFresh?:number}}
 */
export function cleanupRunUploads(before, {
  keep = keepTestAccounts(),
  minAgeMs = 0
} = {}) {
  if (keep) return { skipped: true };
  if (!fs.existsSync(UPLOAD_ROOT)) return { removed: 0, kept: 0, skippedFresh: 0 };

  const rootPrefix = UPLOAD_ROOT + path.sep;
  const refs = collectReferencedUrls();
  const now = Date.now();
  const ageLimit = Math.max(0, Number(minAgeMs) || 0);

  let removed = 0;
  let kept = 0;
  let skippedFresh = 0;

  for (const p of walk(UPLOAD_ROOT)) {
    if (before.has(p)) continue;                       // 不是本次新增
    if (p.endsWith('.gitkeep') || p.endsWith('.part')) continue;
    if (!p.startsWith(rootPrefix)) continue;           // 双保险：只动 uploads/ 里的

    if (ageLimit > 0) {
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs < ageLimit) { skippedFresh += 1; continue; }
      } catch { continue; }
    }

    const url = '/uploads/' + path.relative(UPLOAD_ROOT, p).split(path.sep).join('/');
    if (refs.has(url)) { kept += 1; continue; }        // 还有人引用（已发出去的消息 / 头像…）
    try { fs.unlinkSync(p); removed += 1; } catch { /* ignore */ }
  }

  // 顺带清掉空目录（只删空的）
  for (const sub of ['custom', 'tmp']) {
    const dir = path.join(UPLOAD_ROOT, sub);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch { /* ignore */ }
    }
  }

  console.log(
    `\x1b[90m收尾：已清掉本次自检产生且无人引用的上传文件 ${removed} 个`
    + `${kept ? `（保留 ${kept} 个仍被引用的）` : ''}`
    + `${skippedFresh ? `（跳过 ${skippedFresh} 个最近 ${Math.round(ageLimit / 60000)} 分钟内改动过的）` : ''}`
    + `\x1b[0m`
  );
  return { removed, kept, skippedFresh };
}