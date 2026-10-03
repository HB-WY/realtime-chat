// scripts/plugin_v3_check.mjs
//
// 插件系统 v3 专项回归。
//
// ============================================================
// 覆盖范围（v3 新增能力，原有 plugin_check.mjs 不覆盖这些）
// ============================================================
//
//   1. 多文件项目：上传含 pages/ + lib/ 的项目，所有文件都被正确落盘
//   2. manifest.pages 校验：
//      · entry 必须在 pages 里
//      · 每个 page.path 必须在 files 里
//      · 非法路径（..）被拒
//      · 非 .html 后缀被拒
//      · 路径重复被拒
//   3. entry HTML 注入（服务端 buildEntryHtml）：
//      · <base href="/api/plugins/<id>/a/<ticket>/"> 在 <head> 开头
//      · <script data-injected="host-api"> 桥脚本被注入
//      · 桥脚本是 v3（有 navigate / getCurrentPages / getLaunchParams）
//      · manifest.pages[].title 覆盖页面的 <title>
//   4. 页面通道 GET /plugins/:id/p/:ticket/<pagePath>
//      · 合法页面 → 200 + 注入 base + 桥
//      · 不在 manifest.pages 里 → 404
//      · 无效 ticket → 401
//      · 空路径 → 400
//      · 路径穿越 → 400
//   5. 资源通道 GET /plugins/:id/a/:ticket/<relPath>
//      · CSS/JS/深层路径 → 200 + 正确 MIME
//      · 无效 ticket → 401
//      · 路径穿越 → 400
//      · 文件不存在 → 404
//   6. CSP 动态 origin（多文件关键修复）：
//      · script-src / style-src 等包含请求的 origin
//      · connect-src 仍为 'none'（插件不能直接 fetch）
//      · frame-ancestors 'self'
//      · X-Content-Type-Options: nosniff
//      · HTML 通道 Cache-Control: no-store
//      · 资源通道 Cache-Control: private
//   7. 版本历史：
//      · 上传 v1.0.0 → v2.0.0，/versions 返回 2 条
//      · 归档目录 uploads/plugins/.history/<id>/1.0.0/ 存在
//      · changelog 被记录
//      · 版本号倒退被拒（v0.9.0 < v2.0.0）
//
// ============================================================
// 自包含
// ============================================================
//   · 临时目录 + 临时空库 + 临时上传目录 + 隔离端口
//   · 不碰 server/chat.db，不碰 server/uploads/
//   · 跑完杀掉子进程 + 删临时目录
//
// ============================================================
// 用法
// ============================================================
//   cd server && node scripts/plugin_v3_check.mjs
//   或：npm run test:plugins-v3
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plgv3-'));
const SHIPPED = fs.readFileSync(path.join(SERVER_ROOT, 'config.yaml'), 'utf8');
const TS = Date.now().toString().slice(-7);

let passed = 0;
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 端口探测（**修 bug**：必须传 port 才能真正检测空闲）
//
// 上一版写成 srv.listen('127.0.0.1')，Node 会当 host 处理、port 随机，
// 于是永远返回「起始端口可用」，但那个端口可能真的被僵尸进程占着。
// 这一版改成和 security_check.mjs 里一样的 pickPort 模式。
// ============================================================
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 40; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`从 ${start} 开始找不到可用端口（40 个都试过了）`);
}

// ============================================================
// 带超时的 fetch
//
// 上一版的问题：直接 fetch(/health) 如果碰到「TCP 连得上但不响应 HTTP」
// 的情况（僵尸进程占着端口），会挂几分钟也不 reject。
// 加 AbortController 强制 1.5 秒超时。
// ============================================================
async function fetchWithTimeout(url, opts = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 构造多文件插件包（不依赖 plugins-demo/pack-plugin.mjs）
// ============================================================
function buildPluginBundle(id, version, opts = {}) {
  const manifest = {
    id,
    name: `多页测试 ${id}`,
    version,
    description: 'v3 集成测试',
    entry: 'pages/index/index.html',
    pages: [
      { path: 'pages/index/index.html', title: '首页' },
      { path: 'pages/about/about.html', title: '关于我们' }
    ],
    permissions: ['ui:close', 'storage']
  };
  if (opts.manifestPatch) Object.assign(manifest, opts.manifestPatch);

  const files = {
    'pages/index/index.html':
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>原 index 标题</title>' +
      '<link rel="stylesheet" href="pages/index/index.css">' +
      '</head><body><h1>Index</h1>' +
      '<script src="pages/index/index.js"></script>' +
      '</body></html>',
    'pages/index/index.css': 'body { background: #abc; }',
    'pages/index/index.js': 'console.log("index loaded");',
    'pages/about/about.html':
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>原 about 标题</title></head>' +
      '<body><h1>About</h1></body></html>',
    'lib/util.js': 'window.UTIL = { version: 1 };'
  };

  if (opts.filesPatch) {
    for (const [k, v] of Object.entries(opts.filesPatch)) {
      if (v === null) delete files[k];
      else files[k] = v;
    }
  }

  return Buffer.from(JSON.stringify({ manifest, files }), 'utf8');
}

async function uploadPlugin(base, token, buf, filename = 'test.plugin') {
  const fd = new FormData();
  fd.append('bundle', new Blob([buf], { type: 'application/json' }), filename);
  const res = await fetch(`${base}/api/plugins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

// ============================================================
// 起隔离实例
// ============================================================
console.log('═'.repeat(58));
console.log('  插件系统 v3 专项回归');
console.log('═'.repeat(58));

const port = await pickPort(3071);
console.log(`隔离目录：${TMP}`);
console.log(`端口：${port}`);

const cfgFile = path.join(TMP, 'plgv3.yaml');
const uploadRoot = path.join(TMP, 'uploads').replace(/\\/g, '/');
const dbPath = path.join(TMP, 'plgv3.db');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${dbPath.replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${uploadRoot}`), 'utf8');

const logFile = path.join(TMP, 'plgv3.log');
const fd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined, SERVE_CLIENT: '0' },
  stdio: ['ignore', fd, fd]
});

// 子进程过早退出时提前报错，不白白等 20 秒
child.on('exit', (code) => {
  if (code !== 0 && code !== null && !passed && !failed) {
    console.error(`\n\x1b[31m子进程意外退出（code=${code}），日志：\x1b[0m`);
    try {
      console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
    } catch { /* ignore */ }
  }
});

const BASE = `http://127.0.0.1:${port}`;
const PLUGIN_DIR = path.join(TMP, 'uploads', 'plugins');
const HISTORY_DIR = path.join(PLUGIN_DIR, '.history');

// ============================================================
// 主流程
// ============================================================
let exitCode = 1;
try {
  // ---- 等服务起来（带进度输出）----
  process.stdout.write('等待隔离实例启动');
  const deadline = Date.now() + 20000;
  let up = false;
  let dots = 0;
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetchWithTimeout(`${BASE}/health`, {}, 1500);
      if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    process.stdout.write('.');
    dots++;
    if (dots % 10 === 0) process.stdout.write(` ${Math.round((Date.now() - (deadline - 20000)) / 1000)}s`);
    await sleep(200);
  }
  process.stdout.write('\n');
  if (!up) {
    console.error('\n\x1b[31m实例启动失败，日志：\x1b[0m');
    console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
    throw new Error('实例启动超时（20 秒）');
  }
  console.log('实例已就绪 ✓');

  // ============================================================
  section('0. 准备账号（A=作者）');
  // ============================================================
  let A = null;
  {
    const username = `plgv3_${TS}_a`;
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass1234', nickname: '作者' })
    });
    const d = await res.json();
    A = { username, token: d?.token, id: d?.user?.id };
    ok(res.status === 200 && !!A.token, `注册 ${username}`, d);
  }

  // ============================================================
  section('1. manifest.pages 校验');
  // ============================================================
  const pidBase = `v3-${TS}`;
  {
    // 1.1 pages 里路径穿越 → 拒
    const bad1 = buildPluginBundle(pidBase + '-bad1', '1.0.0', {
      manifestPatch: { pages: [{ path: '../evil.html', title: 'bad' }] }
    });
    const r1 = await uploadPlugin(BASE, A.token, bad1, 'bad1.plugin');
    ok(r1.status === 400 && /路径不合法|不允许/.test(r1.data?.error || ''),
      '【校验】pages 里的路径穿越被拒', r1.data);

    // 1.2 pages 里的路径不是 .html → 拒
    const bad2 = buildPluginBundle(pidBase + '-bad2', '1.0.0', {
      manifestPatch: { pages: [{ path: 'pages/index/index.js' }] }
    });
    const r2 = await uploadPlugin(BASE, A.token, bad2, 'bad2.plugin');
    ok(r2.status === 400 && /\.html/.test(r2.data?.error || ''),
      '【校验】pages 里的路径必须是 .html', r2.data);

    // 1.3 entry 不在 pages 里 → 拒
    const bad3 = buildPluginBundle(pidBase + '-bad3', '1.0.0', {
      manifestPatch: {
        entry: 'pages/index/index.html',
        pages: [{ path: 'pages/about/about.html' }]
      }
    });
    const r3 = await uploadPlugin(BASE, A.token, bad3, 'bad3.plugin');
    ok(r3.status === 400 && /entry.*pages/.test(r3.data?.error || ''),
      '【校验】entry 必须出现在 pages 里', r3.data);

    // 1.4 pages 指向不存在的文件 → 拒
    const bad4 = buildPluginBundle(pidBase + '-bad4', '1.0.0', {
      filesPatch: { 'pages/index/index.html': null }
    });
    const r4 = await uploadPlugin(BASE, A.token, bad4, 'bad4.plugin');
    ok(r4.status === 400, '【校验】pages 里指向不存在的文件被拒', r4.data);

    // 1.5 pages 里路径重复 → 拒
    const bad5 = buildPluginBundle(pidBase + '-bad5', '1.0.0', {
      manifestPatch: {
        pages: [
          { path: 'pages/index/index.html', title: '首页' },
          { path: 'pages/index/index.html', title: '重复' }
        ]
      }
    });
    const r5 = await uploadPlugin(BASE, A.token, bad5, 'bad5.plugin');
    ok(r5.status === 400 && /重复/.test(r5.data?.error || ''),
      '【校验】pages 里路径重复被拒', r5.data);
  }

  // ============================================================
  section('2. 上传合法多文件插件');
  // ============================================================
  const pluginId = `${pidBase}-ok`;
  let uploadedPlugin = null;
  let ticket = null;
  {
    const buf = buildPluginBundle(pluginId, '1.0.0');
    const r = await uploadPlugin(BASE, A.token, buf);
    ok(r.status === 200 && r.data?.ok, '上传含 pages + lib 的插件成功', r.data);
    uploadedPlugin = r.data?.plugin;
    ok(uploadedPlugin?.id === pluginId, '插件 id 与 manifest 一致');
    ok(uploadedPlugin?.version === '1.0.0', '版本号 1.0.0');
    ok(Array.isArray(uploadedPlugin?.pages) && uploadedPlugin.pages.length === 2,
      'DTO 里 pages 有 2 项', uploadedPlugin?.pages);
    ok(uploadedPlugin.pages[0].path === 'pages/index/index.html'
      && uploadedPlugin.pages[0].title === '首页',
      'pages[0] 的 path 和 title 正确', uploadedPlugin.pages[0]);

    // 磁盘上确实有所有文件
    const onDisk = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else onDisk.push(path.relative(path.join(PLUGIN_DIR, pluginId), p).split(path.sep).join('/'));
      }
    })(path.join(PLUGIN_DIR, pluginId));
    ok(onDisk.length === 5, '磁盘上有 5 个文件', onDisk);
    for (const f of ['pages/index/index.html', 'pages/index/index.css',
                     'pages/index/index.js', 'pages/about/about.html', 'lib/util.js']) {
      ok(onDisk.includes(f), `磁盘上有 ${f}`);
    }

    // 申请票据
    const t = await fetch(`${BASE}/api/plugins/${pluginId}/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const td = await t.json();
    ticket = td?.ticket;
    ok(t.status === 200 && typeof ticket === 'string', '申请票据成功', td);
  }

  // ============================================================
  section('3. entry HTML 注入（base + 桥 + title）');
  // ============================================================
  {
    const res = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${ticket}`);
    const html = await res.text();
    ok(res.status === 200, 'GET /entry 200', res.status);

    const baseMatch = html.match(/<base\s+href="([^"]+)"/);
    ok(!!baseMatch, '返回的 HTML 里有 <base>', baseMatch?.[1]);
    ok(baseMatch?.[1] === `/api/plugins/${pluginId}/a/${ticket}/`,
      '<base> 指向 /a/<ticket>/', baseMatch?.[1]);
    const baseIdx = html.indexOf('<base');
    const firstLinkIdx = html.indexOf('<link');
    const firstScriptSrcIdx = html.indexOf('<script src=');
    const firstRelSrcIdx = firstScriptSrcIdx >= 0 ? firstScriptSrcIdx : Infinity;
    ok(baseIdx >= 0 && (firstLinkIdx < 0 || baseIdx < firstLinkIdx),
      '<base> 在第一个 <link> 之前', { baseIdx, firstLinkIdx });
    ok(baseIdx >= 0 && baseIdx < firstRelSrcIdx,
      '<base> 在第一个 <script src> 之前', { baseIdx, firstRelSrcIdx });

    ok(/data-injected="host-api"/.test(html), '桥脚本被注入（data-injected="host-api"）');
    ok(/version:\s*3/.test(html), '桥脚本版本为 v3');
    ok(/navigate:\s*navigate/.test(html), '桥脚本暴露 navigate 方法');
    ok(/getCurrentPages:\s*getCurrentPages/.test(html), '桥脚本暴露 getCurrentPages 方法');
    ok(/getLaunchParams:\s*getLaunchParams/.test(html), '桥脚本暴露 getLaunchParams 方法');
    ok(/hostAPI\.stream\s*=|stream:\s*stream/.test(html), '桥脚本暴露 stream 方法');

    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    ok(titleMatch && titleMatch[1] === '首页',
      'title 被 manifest.pages[0].title 覆盖', titleMatch?.[1]);
  }

  // ============================================================
  section('4. 页面通道 /p/:ticket/*');
  // ============================================================
  {
    const r1 = await fetch(`${BASE}/api/plugins/${pluginId}/p/${ticket}/pages/index/index.html`);
    const html1 = await r1.text();
    ok(r1.status === 200, '合法页面（index）→ 200', r1.status);
    ok(/<base\s+href="\/api\/plugins\/[^"]+\/a\//.test(html1), '页面 HTML 有 <base>');
    ok(/data-injected="host-api"/.test(html1), '页面 HTML 有桥脚本');
    ok(/<title>首页<\/title>/.test(html1), '页面 <title> 被覆盖为"首页"');
    ok(/<h1>Index<\/h1>/.test(html1), '页面原有内容保留（<h1>Index</h1>）');

    const r2 = await fetch(`${BASE}/api/plugins/${pluginId}/p/${ticket}/pages/about/about.html`);
    const html2 = await r2.text();
    ok(r2.status === 200, '合法页面（about）→ 200', r2.status);
    ok(/<title>关于我们<\/title>/.test(html2), 'about 页 title 被覆盖');

    const r3 = await fetch(`${BASE}/api/plugins/${pluginId}/p/${ticket}/pages/nope/nope.html`);
    ok(r3.status === 404, '不在 manifest.pages 里的页面 → 404', r3.status);

    const r4 = await fetch(`${BASE}/api/plugins/${pluginId}/p/deadbeef/pages/index/index.html`);
    ok(r4.status === 401, '无效 ticket → 401', r4.status);

    const r5 = await fetch(`${BASE}/api/plugins/${pluginId}/p/${ticket}/`);
    ok(r5.status === 400, '空路径 → 400', r5.status);

    const r6 = await fetch(
      `${BASE}/api/plugins/${pluginId}/p/${ticket}/..%2F..%2F..%2Fetc%2Fpasswd`
    );
    ok(r6.status === 400 || r6.status === 404, '路径穿越 → 400/404', r6.status);
  }

  // ============================================================
  section('5. 资源通道 /a/:ticket/*');
  // ============================================================
  {
    const r1 = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/pages/index/index.css`);
    const css = await r1.text();
    ok(r1.status === 200, 'CSS 文件 → 200', r1.status);
    ok(/text\/css/.test(r1.headers.get('content-type') || ''),
      'CSS 的 Content-Type 正确', r1.headers.get('content-type'));
    ok(/background:\s*#abc/.test(css), 'CSS 内容正确');

    const r2 = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/pages/index/index.js`);
    const js = await r2.text();
    ok(r2.status === 200, 'JS 文件 → 200', r2.status);
    ok(/javascript/.test(r2.headers.get('content-type') || ''),
      'JS 的 Content-Type 正确', r2.headers.get('content-type'));
    ok(/index loaded/.test(js), 'JS 内容正确');

    const r3 = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/lib/util.js`);
    const lib = await r3.text();
    ok(r3.status === 200, '深层路径 lib/util.js → 200', r3.status);
    ok(/window\.UTIL/.test(lib), 'lib/util.js 内容正确');

    const r4 = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/pages/index/index.html`);
    const rawHtml = await r4.text();
    ok(r4.status === 200, '通过 /a/ 直接取 HTML → 200', r4.status);
    ok(!/<base/.test(rawHtml) && !/data-injected/.test(rawHtml),
      '/a/ 通道**不注入**任何东西（返回原始 HTML）');

    const r5 = await fetch(`${BASE}/api/plugins/${pluginId}/a/deadbeef/pages/index/index.css`);
    ok(r5.status === 401, '无效 ticket → 401', r5.status);

    const r6 = await fetch(
      `${BASE}/api/plugins/${pluginId}/a/${ticket}/..%2F..%2F..%2Fconfig.yaml`
    );
    ok(r6.status === 400 || r6.status === 404, '路径穿越 → 400/404', r6.status);

    const r7 = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/no-such-file.txt`);
    ok(r7.status === 404, '不存在的资源 → 404', r7.status);
  }

  // ============================================================
  section('6. CSP 动态 origin（多文件关键修复）');
  // ============================================================
  {
    const entryRes = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${ticket}`);
    const csp = entryRes.headers.get('content-security-policy') || '';
    const origin = `http://127.0.0.1:${port}`;

    ok(csp.includes(origin),
      `CSP 里包含请求 origin（${origin}）`, csp.slice(0, 200));
    ok(/script-src[^;]*127\.0\.0\.1:\d+/.test(csp),
      'script-src 里有本机 origin（多文件脚本能加载）');
    ok(/connect-src\s+'none'/.test(csp),
      "connect-src 'none' 仍然生效", csp.match(/connect-src[^;]*/)?.[0]);
    ok(/frame-ancestors\s+'self'/.test(csp),
      "frame-ancestors 'self' 仍然生效");
    ok(entryRes.headers.get('x-content-type-options') === 'nosniff',
      'X-Content-Type-Options: nosniff');
    ok(/no-store/.test(entryRes.headers.get('cache-control') || ''),
      'HTML 通道 Cache-Control: no-store');

    const pRes = await fetch(`${BASE}/api/plugins/${pluginId}/p/${ticket}/pages/index/index.html`);
    const pCsp = pRes.headers.get('content-security-policy') || '';
    ok(pCsp.includes(origin), '/p/ 通道的 CSP 也包含 origin');

    const aRes = await fetch(`${BASE}/api/plugins/${pluginId}/a/${ticket}/pages/index/index.css`);
    const aCsp = aRes.headers.get('content-security-policy') || '';
    ok(aCsp.includes(origin), '/a/ 通道的 CSP 也包含 origin');
    ok(/private/.test(aRes.headers.get('cache-control') || ''),
      '资源通道 Cache-Control: private（同票据内可缓存）');
  }

  // ============================================================
  section('7. 版本历史');
  // ============================================================
  {
    const v2Buf = buildPluginBundle(pluginId, '2.0.0', {
      filesPatch: { 'pages/index/index.css': 'body { background: #def; }' }
    });
    const fdv2 = new FormData();
    fdv2.append('bundle', new Blob([v2Buf], { type: 'application/json' }), 'v2.plugin');
    fdv2.append('changelog', '修复了 XXX，新增了 YYY');
    const upV2 = await fetch(`${BASE}/api/plugins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${A.token}` },
      body: fdv2
    });
    const upV2Data = await upV2.json();
    ok(upV2.status === 200 && upV2Data?.plugin?.version === '2.0.0',
      '上传 v2.0.0 成功', upV2Data);
    ok(upV2Data?.plugin?.pages?.length === 2, 'v2 的 pages 仍是 2 项');

    const archivedV1 = path.join(HISTORY_DIR, pluginId, '1.0.0');
    ok(fs.existsSync(archivedV1), `归档目录存在：${path.relative(TMP, archivedV1)}`);
    ok(fs.existsSync(path.join(archivedV1, 'pages', 'index', 'index.html')),
      '归档目录里含 v1 的 index.html');

    const archivedCss = fs.readFileSync(
      path.join(archivedV1, 'pages', 'index', 'index.css'), 'utf8'
    );
    ok(/#abc/.test(archivedCss),
      '归档的 CSS 是 v1 内容（#abc），不是新版的 #def');

    {
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare(
        'SELECT version, changelog FROM plugin_versions WHERE plugin_id = ? ORDER BY uploaded_at DESC'
      ).all(pluginId);
      db.close();
      ok(rows.length === 1 && rows[0].version === '1.0.0',
        'plugin_versions 有 1 条 v1.0.0 归档记录', rows);
      ok(rows[0].changelog === '修复了 XXX，新增了 YYY',
        'changelog 被记录到归档记录里', rows[0].changelog);
    }

    const versionsRes = await fetch(`${BASE}/api/plugins/${pluginId}/versions`, {
      headers: { Authorization: `Bearer ${A.token}` }
    });
    const versionsData = await versionsRes.json();
    ok(versionsRes.status === 200, 'GET /versions 200');
    ok(versionsData?.currentVersion === '2.0.0',
      'currentVersion = 2.0.0', versionsData?.currentVersion);
    ok(Array.isArray(versionsData?.versions) && versionsData.versions.length === 1,
      'versions 数组有 1 项（v1.0.0）', versionsData?.versions);
    ok(versionsData.versions[0].version === '1.0.0', '归档记录里是 v1.0.0');
    ok(versionsData.versions[0].changelog === '修复了 XXX，新增了 YYY',
      '归档记录的 changelog 正确');

    const v09Buf = buildPluginBundle(pluginId, '0.9.0');
    const up09 = await uploadPlugin(BASE, A.token, v09Buf, 'v09.plugin');
    ok(up09.status === 400 && /低于当前版本|回退/.test(up09.data?.error || ''),
      '版本号倒退（0.9.0 < 2.0.0）被拒', up09.data);

    const newEntryRes = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${ticket}`);
    const newEntryHtml = await newEntryRes.text();
    ok(/background:\s*#def/.test(newEntryHtml)
      || /pages\/index\/index\.css/.test(newEntryHtml),
      '更新后 entry HTML 引用的是新版本资源');
  }

  // ============================================================
  section('8. 收尾');
  // ============================================================
  {
    const del = await fetch(`${BASE}/api/plugins/${pluginId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${A.token}` }
    });
    ok(del.status === 200, '作者删除插件 → 200');
    ok(!fs.existsSync(path.join(PLUGIN_DIR, pluginId)), '插件主目录已删除');
    ok(!fs.existsSync(path.join(HISTORY_DIR, pluginId)), '插件版本历史目录也已删除');
  }

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n插件 v3 回归异常：', err);
  try {
    console.error('--- 服务端日志尾部 ---\n' +
      fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'));
  } catch { /* ignore */ }
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