// scripts/image_check.mjs
//
// 图片上传前的客户端规范化（`client/src/utils/image.js`）回归。
//
// 为什么必须用真浏览器跑：这段逻辑要 canvas / createImageBitmap / EXIF 方向 /
// toBlob 编码，Node 里没有 DOM，跑不了。所以这里起一个只读的本地静态服务把
// image_harness.html 与 client/src/utils/image.js 喂给**无头 Edge**，
// 页面把断言结果 POST 回来。
//
// 它守住的是「手机照片能不能传」这件事本身：
//   · 4000×3000 / 10MB 的直出照片 → 压到 ≤1024 且 ≤3.5MB（否则撞头像上限）
//   · EXIF Orientation=6 的照片 → 输出必须是竖的（不然上传后横躺）
//   · 带透明的 PNG 不能被压成白底、GIF 不能被压掉动画、非图片不动
//   · 解不开的格式（桌面浏览器遇到 HEIC）→ 给出可执行的提示
//
// 用法：cd server && node scripts/image_check.mjs
//
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', 'client');
const HARNESS = path.join(HERE, 'image_harness.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome'
];
const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('找不到 Edge / Chrome，无法运行本检查（其余套件不受影响）');
  process.exit(2);
}
if (!fs.existsSync(HARNESS)) {
  console.error(`找不到 harness：${HARNESS}`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8'
};

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

const PORT = await freePort(3411);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcheck-profile-'));
let resolveResult;
const resultArrived = new Promise((r) => { resolveResult = r; });

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(204).end(); resolveResult(body); });
    return;
  }
  // 只读地把 client/ 当静态根：页面因此能 import /src/utils/image.js
  const rel = req.url === '/' ? '' : decodeURIComponent(req.url.split('?')[0]);
  const file = rel === '' ? HARNESS : path.join(CLIENT, rel);
  const inside = file === HARNESS || file.startsWith(CLIENT + path.sep);
  if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`harness：http://127.0.0.1:${PORT}/  （浏览器：${path.basename(BROWSER)}）`);

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  `--user-data-dir=${PROFILE}`,
  `http://127.0.0.1:${PORT}/`
], { stdio: 'ignore' });

const TIMEOUT_MS = 90000;
const body = await Promise.race([
  resultArrived,
  new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))
]);

let exitCode = 1;
if (!body) {
  console.error(`超时（${TIMEOUT_MS / 1000}s）：页面没有回传结果`);
} else {
  let pass = 0;
  let fail = 0;
  for (const r of JSON.parse(body)) {
    if (r.ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${r.label}`); }
    else { fail++; console.log(`  \x1b[31m✗ ${r.label}\x1b[0m${r.extra !== undefined ? ' → ' + JSON.stringify(r.extra) : ''}`); }
  }
  console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
  exitCode = fail === 0 ? 0 : 1;
}

try { browser.kill(); } catch { /* ignore */ }
server.close();
await new Promise((r) => setTimeout(r, 500));
for (let i = 0; i < 5; i++) {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; }
  catch { await new Promise((r) => setTimeout(r, 300)); }
}
process.exit(exitCode);
