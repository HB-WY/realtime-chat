// scripts/static_host_check.mjs
//
// 单端口部署回归：后端在**同一个端口**托管前端产物（server/config.yaml → client.serve）。
// 这是局域网共享的正路，但它的挂载顺序特别容易写错，一旦错了会**静默**出问题：
//   · 前端静态文件吃掉 /api       → 前端收到 HTML 而不是 JSON
//   · SPA fallback 吃掉 /health   → 健康检查变成一整页 HTML（§1.24 的老坑）
//   · SPA fallback 吃掉 /uploads  → 「文件不存在」变成 200 + HTML
//   · 反过来把 /src、/vite.config.js 托管出去 → 就是 F-01 的源码泄露
// 所以这里把这几条都钉成断言。
//
// 自包含：自己生成隔离配置 + 临时空库，自己拉起独立端口的实例，跑完杀掉并删干净。
// **不需要先起服务**；只读地使用 client/dist（所以要先 build，见下方提示）。
//
// 用法：cd client && npm run build && cd ../server && node scripts/static_host_check.mjs
//
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const CLIENT_DIST = path.join(SERVER_ROOT, '..', 'client', 'dist');
const require = createRequire(path.join(SERVER_ROOT, '..', 'client', 'package.json'));
const { io } = require('socket.io-client');

let passed = 0;
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  console.error(`找不到前端产物：${path.join(CLIENT_DIST, 'index.html')}`);
  console.error('请先执行：cd client && npm run build');
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hostcheck-'));
const SHIPPED = fs.readFileSync(path.join(SERVER_ROOT, 'config.yaml'), 'utf8');

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 40; p++) if (await portFree(p)) return p;
  throw new Error('找不到可用端口');
}

let child = null;

async function startServer(port) {
  const dbPath = path.join(TMP, 'host.db').replace(/\\/g, '/');
  const distPath = CLIENT_DIST.replace(/\\/g, '/');
  let cfg = SHIPPED
    .replace('  port: 3001', `  port: ${port}`)
    .replace('  path: chat.db', `  path: ${dbPath}`)
    .replace('  dist: ../client/dist', `  dist: ${distPath}`);
  if (!cfg.includes(`dist: ${distPath}`)) throw new Error('配置模板里找不到 client.dist');
  const cfgFile = path.join(TMP, 'host.yaml');
  fs.writeFileSync(cfgFile, cfg, 'utf8');

  const logFile = path.join(TMP, 'host.log');
  const fd = fs.openSync(logFile, 'a');
  // 刻意绑 127.0.0.1：本脚本验证的是「托管与挂载顺序」，不是对外暴露
  child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined },
    stdio: ['ignore', fd, fd]
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`实例启动失败：\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(无日志)'}`);
}

const get = async (url) => {
  const r = await fetch(url);
  return { status: r.status, body: await r.text(), type: r.headers.get('content-type') || '', cc: r.headers.get('cache-control') || '' };
};

let exitCode = 1;
try {
  const port = await pickPort(3021);
  const BASE = `http://127.0.0.1:${port}`;
  await startServer(port);
  console.log(`隔离目录：${TMP}`);

  console.log('\n\x1b[36m1. 前端产物由后端托管\x1b[0m');
  const idx = await get(`${BASE}/`);
  ok(idx.status === 200 && /<div id="root">/.test(idx.body), '/ 返回 SPA 外壳');
  const jsPath = idx.body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const cssPath = idx.body.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  ok(!!jsPath && !!cssPath, '外壳引用的是打包产物（不是 /src/main.jsx）', { jsPath, cssPath });
  const js = await get(BASE + jsPath);
  ok(js.status === 200 && js.body.length > 1000, '构建后的 js 可下载');
  ok(/immutable/.test(js.cc), '带 hash 的产物给了 immutable 长缓存', js.cc);
  ok((await get(`${BASE}${cssPath}`)).status === 200, '构建后的 css 可下载');
  const logo = await get(`${BASE}/logo.jpg`);
  ok(logo.status === 200 && logo.type.startsWith('image/'), 'public/ 静态文件（logo.jpg）可访问');
  const deep = await get(`${BASE}/some/view/route`);
  ok(deep.status === 200 && /<div id="root">/.test(deep.body), '任意前端路由回落到 SPA 外壳（自写视图路由需要）');

  console.log('\n\x1b[36m2. 不泄露源码 / 配置（F-01 的泄露面）\x1b[0m');
  for (const p of ['/src/main.jsx', '/src/App.jsx', '/vite.config.js', '/package.json', '/package-lock.json', '/node_modules/.vite/deps/_metadata.json']) {
    const r = await get(BASE + p);
    ok(!(r.status === 200 && !/^\s*<!doctype html>/i.test(r.body)), `${p} 不可下载`, { status: r.status, head: r.body.slice(0, 40) });
  }
  const map = await get(`${BASE}${jsPath}.map`);
  ok(!(map.status === 200 && !/doctype html/i.test(map.body)), 'source map 不可下载', map.status);

  console.log('\n\x1b[36m3. 挂载顺序：接口不能被前端吃掉\x1b[0m');
  const a401 = await get(`${BASE}/api/v1/state`);
  ok(a401.status === 401 && a401.type.includes('json') && /error/.test(a401.body), '/api/v1/state 仍是 JSON 401', [a401.status, a401.type]);
  const a404 = await get(`${BASE}/api/nope`);
  ok(a404.status === 404 && a404.type.includes('json'), '未匹配的 /api/* 仍是 JSON 404', [a404.status, a404.type]);
  const health = await get(`${BASE}/health`);
  ok(health.status === 200 && health.type.includes('json') && /"ok":true/.test(health.body), '/health 仍是 JSON（§1.24 的坑）', [health.status, health.body.slice(0, 40)]);

  console.log('\n\x1b[36m4. 上传文件与 socket.io 同源\x1b[0m');
  const miss = await get(`${BASE}/uploads/avatars/definitely-missing.png`);
  ok(!(miss.status === 200 && /doctype html/i.test(miss.body)), '缺失的上传文件不回落成 index.html', miss.status);
  const poll = await get(`${BASE}/socket.io/?EIO=4&transport=polling`);
  ok(poll.status === 200 && poll.body.startsWith('0{'), 'socket.io 轮询握手同源可用', poll.body.slice(0, 30));
  await new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 6000 });
    const t = setTimeout(() => { ok(false, 'WebSocket 升级超时'); s.close(); resolve(); }, 8000);
    s.on('connect_error', (e) => {
      clearTimeout(t);
      ok(/未登录|登录已过期/.test(e.message), 'WebSocket 升级可用（未带凭据 → 业务层拒绝，而非连接失败）', e.message);
      s.close(); resolve();
    });
    s.on('connect', () => { clearTimeout(t); ok(false, '未鉴权却连上了'); s.close(); resolve(); });
  });

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n单端口回归异常：', err);
  exitCode = 1;
} finally {
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(400);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
    catch { await sleep(300); }
  }
  console.log(`已清理隔离目录：${TMP}`);
}
process.exit(exitCode);
