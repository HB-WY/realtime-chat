// scripts/upload_format_check.mjs
//
// 上传格式白名单回归：把「哪些图片格式能传、哪些必须拒绝、拒绝时说什么」
// 钉成断言，避免以后改 config.yaml / 白名单时**悄悄**把手机上传改坏。
//
// 策略（有意为之，不是遗漏）：
//   收：PNG / JPG / JPEG / GIF / WebP / BMP / AVIF —— 浏览器都能直接显示
//   拒：HEIC / HEIF / TIFF —— 桌面浏览器渲染不了，存下来就是一张裂图。
//       手机拍的 HEIC 由客户端 image.js 转成 JPEG 再上传（见 scripts/image_check.mjs），
//       所以「手机上能传」与「服务端不收 HEIC」并不矛盾。
//
// 自包含：临时配置 + 临时空库 + 临时上传目录，自己拉起隔离端口的实例，
// 跑完杀掉并删干净。不碰 chat.db，也不写 uploads/。
//
// 用法：cd server && node scripts/upload_format_check.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtcheck-'));
const SHIPPED = fs.readFileSync(path.join(SERVER_ROOT, 'config.yaml'), 'utf8');
const TS = Date.now().toString().slice(-7);

let passed = 0;
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// 极简合法字节：服务端判的是「扩展名 + MIME」，不是魔数
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x20), Buffer.from([0xff, 0xd9])]);
const BIG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6 * 1024 * 1024, 0x20), Buffer.from([0xff, 0xd9])]);

// [文件名, MIME, 字节, 头像该不该收, 资源池该不该收]
const CASES = [
  ['a.jpg', 'image/jpeg', JPEG, true, true],
  ['a.jpeg', 'image/jpeg', JPEG, true, true],
  ['a.png', 'image/png', PNG, true, true],
  ['a.gif', 'image/gif', PNG, true, true],
  ['a.webp', 'image/webp', JPEG, true, true],
  ['a.bmp', 'image/bmp', JPEG, true, true],
  ['a.avif', 'image/avif', JPEG, true, true],
  ['a.heic', 'image/heic', JPEG, false, false],
  ['a.heif', 'image/heif', JPEG, false, false],
  ['a.tiff', 'image/tiff', JPEG, false, false],
  ['big.jpg', 'image/jpeg', BIG, true, true]    // 6MB：头像上限已提到 8MB，应该过
];

const port = await freePort(3031);
const cfgFile = path.join(TMP, 'fmt.yaml');
const uploadRoot = path.join(TMP, 'uploads').replace(/\\/g, '/');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${path.join(TMP, 'fmt.db').replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${uploadRoot}`)
  // [CHANGED] 本套脚本同一用户密集上传几十次，放宽新加的上传限流
  //   （配置文件是 CRLF 行尾，用行尾无关的正则匹配）
  .replace(/(upload:\r?\n\s+window_ms: 60000\r?\n\s+max:) 20/, '$1 1000'), 'utf8');

const logFile = path.join(TMP, 'fmt.log');
const fd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined, SERVE_CLIENT: '0' },
  stdio: ['ignore', fd, fd]
});

const BASE = `http://127.0.0.1:${port}`;
let exitCode = 1;
try {
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`实例启动失败：\n${fs.readFileSync(logFile, 'utf8')}`);

  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `fmt_${TS}`, password: 'pass1234', nickname: '格式探针' })
  });
  const { token } = await reg.json();
  if (!token) throw new Error('注册失败');

  const upload = async (url, field, caseRow, withKind) => {
    const [name, type, buf] = caseRow;
    const form = new FormData();
    form.append(field, new Blob([buf], { type }), name);
    if (withKind) form.append('kind', 'image');
    const res = await fetch(BASE + url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    let msg = '';
    try { const d = await res.json(); msg = d.error || ''; } catch { /* ignore */ }
    return { status: res.status, msg };
  };

  console.log('\n\x1b[36m1. 头像（uploads.avatar）\x1b[0m');
  let heicMsg = '';
  for (const c of CASES) {
    const r = await upload('/api/avatar', 'avatar', c, false);
    const accepted = r.status === 200;
    ok(accepted === c[3], `${c[0]}（${c[1]}）→ ${c[3] ? '应接受' : '应拒绝'}，实际 ${r.status}`, r.msg);
    if (c[0] === 'a.heic') heicMsg = r.msg;
  }
  ok(/PNG/.test(heicMsg) && /AVIF/.test(heicMsg), 'HEIC 的拒绝文案列出了真正支持的格式（可指导用户）', heicMsg);
  ok(!/只支持 PNG \/ JPG \/ GIF \/ WebP 图片$/.test(heicMsg), '拒绝文案不再是过期的旧清单', heicMsg);

  console.log('\n\x1b[36m2. 资源池（business.assets）\x1b[0m');
  for (const c of CASES) {
    const r = await upload('/api/assets/upload', 'file', c, true);
    const accepted = r.status === 200;
    ok(accepted === c[4], `${c[0]} → ${c[4] ? '应接受' : '应拒绝'}，实际 ${r.status}`, r.msg);
  }

  console.log('\x1b[90m（对照）聊天附件 /api/file 不限制类型，HEIC 也能当文件发\x1b[0m');
  const heicAsFile = await upload('/api/file', 'file', CASES.find((c) => c[0] === 'a.heic'), false);
  ok(heicAsFile.status === 200, '聊天附件仍然不限图片类型', heicAsFile.msg);

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n上传格式回归异常：', err);
  exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
    catch { await sleep(300); }
  }
  console.log(`已清理隔离目录：${TMP}`);
}
process.exit(exitCode);
