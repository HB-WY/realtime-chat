// scripts/file_types_check.mjs
//
// 文件类型表回归（`GET /api/file-types` + config.yaml → files.types 的校验）。
//
// 这条链路是给「开发者手动给新增类型配封面」用的，最怕两件事：
//   1) 配置写错一个字符就让整个后端起不来（应该只警告并跳过那一条）
//   2) 封面地址没校验就下发，前端渲染出裂图 / 放行奇怪 scheme
// 所以这里既测「合法条目被正确规范化」，也测「非法条目被跳过且服务照常启动」。
//
// 自包含：临时配置 + 临时空库 + 临时上传目录 + 隔离端口，跑完删干净。
//
// 用法：cd server && node scripts/file_types_check.mjs
//
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ftcheck-'));
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

const CUSTOM_YAML = `  types:
    # 合法：新类型 + 封面
    - key: psd
      label: PSD
      color: '#31a8ff'
      exts: ['.psd', 'PSB']
      cover: '/uploads/covers/psd.png'
    # 合法：新类型、不配封面（用内置通用图形）
    - key: apk
      exts: ['.apk', '.aab']
    # 合法：覆盖内置类型的颜色与封面（key 与内置 video 同名）
    - key: video
      color: '#123456'
      exts: ['.mp4', '.mov']
      cover: 'https://example.com/video.png'
    # 非法：key 含大写/空格
    - key: Bad Key
      exts: ['.xxx']
    # 非法：没有合法扩展名
    - key: noext
      exts: ['', '..', '.工具']
    # 非法：封面是 javascript: 这类不受支持的 scheme → 该条按「无封面」保留
    - key: weirdcover
      exts: ['.wc']
      cover: 'javascript:alert(1)'
    # 非法：key 重复
    - key: psd
      exts: ['.dup']
    # 非法：非对象
    - just-a-string`;

const port = await freePort(3041);
const cfgFile = path.join(TMP, 'ft.yaml');
if (!SHIPPED.includes('  types: []')) throw new Error('配置模板里找不到 files.types 占位');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${path.join(TMP, 'ft.db').replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${path.join(TMP, 'uploads').replace(/\\/g, '/')}`)
  .replace('  types: []', CUSTOM_YAML), 'utf8');

const logFile = path.join(TMP, 'ft.log');
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

  console.log('\n\x1b[36m1. 配置非法条目不能拖垮启动\x1b[0m');
  ok(true, '含 4 条非法配置时服务仍正常启动（只警告跳过）');
  const log = fs.readFileSync(logFile, 'utf8');
  ok(/key 不合法/.test(log), '非法 key 有明确警告', log.split('\n').filter((l) => /警告|key 不合法/.test(l)).slice(0, 1));
  ok(/没有合法扩展名/.test(log), '无扩展名有明确警告');
  ok(/重复/.test(log), '重复 key 有明确警告');
  ok(/cover/.test(log), '非法封面地址有明确警告');
  ok(/非对象条目/.test(log), '非对象条目有明确警告');

  console.log('\n\x1b[36m2. 接口鉴权\x1b[0m');
  const noAuth = await fetch(`${BASE}/api/file-types`);
  ok(noAuth.status === 401, '未登录访问 /api/file-types → 401', noAuth.status);

  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `ft_${TS}`, password: 'pass1234', nickname: '类型探针' })
  });
  const { token } = await reg.json();
  const res = await fetch(`${BASE}/api/file-types`, { headers: { Authorization: `Bearer ${token}` } });
  const { types } = await res.json();
  ok(res.status === 200 && Array.isArray(types), '/api/file-types 下发数组', res.status);

  const byKey = Object.fromEntries(types.map((t) => [t.key, t]));

  console.log('\n\x1b[36m3. 合法条目被正确规范化\x1b[0m');
  ok(types.length === 4, '只下发 4 条合法类型（非法条目被跳过）', types.map((t) => t.key));
  ok(byKey.psd?.exts?.join(',') === '.psd,.psb', '扩展名统一小写并补前导点（.PSD/.psb → .psd/.psb）', byKey.psd?.exts);
  ok(byKey.psd?.label === 'PSD' && byKey.psd?.color === '#31a8ff', '保留 label / color', byKey.psd);
  ok(byKey.psd?.cover === '/uploads/covers/psd.png', '站内封面地址原样保留', byKey.psd?.cover);
  ok(byKey.apk?.cover === null && byKey.apk?.label === 'APK', '不配封面 → cover=null，label 缺省用 key 大写', byKey.apk);
  ok(byKey.video?.color === '#123456' && /^https:\/\//.test(byKey.video?.cover || ''),
    '覆盖内置类型：颜色与 https 外链封面都生效', byKey.video);
  ok(byKey.weirdcover?.cover === null, '非法 scheme 的封面被丢弃、条目本身保留', byKey.weirdcover);

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n文件类型回归异常：', err);
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
