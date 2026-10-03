// scripts/security_check.mjs
//
// 安全控制回归：本轮渗透测试报告（F-01 ~ F-05）对应修复的**行为级**验证。
//
//   1. 监听地址：后端缺省只绑回环；config.yaml 写了 host 才对外
//   2. 密钥 IP 绑定：boundIp 不一致 → 403（F-03，原先只记录不校验）
//   3. 来源 IP 可信：XFF 伪造头在直连部署下不生效（F-03 的前提）
//   4. 登录失败限流：超过阈值 → 429（F-04）
//   5. 在线列表可见范围：非好友 / 非同群不可见，且不下发 username（F-05）
//
// 设计：**完全自包含**。自己在系统临时目录里生成隔离配置 + 独立数据库，
// 自己拉起独立端口的后端实例，跑完杀掉并删干净。
//   · 绝不连 chat.db、绝不碰正在运行的服务（遵守 DEVLOG §2「测试脚本不得改动真实数据」）
//   · 唯一例外：为拿到两个不同的**真实来源 IP**（127.0.0.1 与局域网 IP），
//     其中一个实例绑 0.0.0.0。它用的是临时空库、只存活数秒。
//
// 用法：cd server && node scripts/security_check.mjs
//   （需要 socket.io-client：从 client/node_modules 解析，与 socket_check 一致）
//
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const require = createRequire(path.join(SERVER_ROOT, '..', 'client', 'package.json'));
const { io } = require('socket.io-client');

const TS = Date.now().toString().slice(-7);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seccheck-'));
const SHIPPED = fs.readFileSync(path.join(SERVER_ROOT, 'config.yaml'), 'utf8');

let passed = 0;
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------
// 工具
// ---------------------------------------------------------------
/** 取一个非回环 IPv4（用来制造「另一个真实来源 IP」） */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

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

function patchConfig(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`配置模板缺少片段：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  return out;
}

const THE_LAN_IP = lanIp();

function makeConfig(name, { port, host, perIp, perAccount, scope }) {
  const dbPath = path.join(TMP, `${name}.db`).replace(/\\/g, '/');
  const reps = [
    ['  port: 3001', `  port: ${port}`],
    ['  path: chat.db', `  path: ${dbPath}`]
  ];
  if (host) reps.push(['  host: 127.0.0.1', `  host: ${host}`]);
  // [CHANGED] 带 login: 上下文再替换：config.yaml 的 rate_limits 里
  // 现在还有 register.max_per_ip（文本相同、位置更靠前），裸字符串会撞。
  if (perIp) reps.push(['  login:\n    window_ms: 900000\n    max_per_ip: 30', `  login:\n    window_ms: 900000\n    max_per_ip: ${perIp}`]);
  if (perAccount) reps.push(['    max_per_account: 10', `    max_per_account: ${perAccount}`]);
  if (scope) reps.push(['    scope: related', `    scope: ${scope}`]);
  const file = path.join(TMP, `${name}.yaml`);
  fs.writeFileSync(file, patchConfig(SHIPPED, reps), 'utf8');
  return { file, dbPath };
}

const children = [];

async function startServer(name, cfgFile, port) {
  // 日志落到隔离目录：启动失败时能直接看到原因，又不会把 stdout 管道化
  const logFile = path.join(TMP, `${name}.log`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_ROOT,
    // [CHANGED] 部分实例绑 0.0.0.0：config.js 现在对「对外监听 + 默认 JWT 密钥」
    // 直接拒绝启动（本次安全修复），测试实例必须带随机密钥。
    env: {
      ...process.env,
      APP_CONFIG: cfgFile,
      PORT: undefined,
      HOST: undefined,
      JWT_SECRET: crypto.randomUUID() + crypto.randomUUID()
    },
    stdio: ['ignore', fd, fd]
  });
  children.push(child);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return child;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(无日志)';
  throw new Error(`实例 ${port} 启动失败（exitCode=${child.exitCode}）：\n${log}`);
}

function stopAll() {
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
}

async function api(base, p, o = {}) {
  const headers = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.key) headers['X-API-Key'] = o.key;
  if (o.headers) Object.assign(headers, o.headers);
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, {
    method: o.method || 'GET',
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

const register = (base, username, password = 'pass1234') =>
  api(base, '/api/auth/register', { method: 'POST', body: { username, password, nickname: username } });

const login = (base, username, password) =>
  api(base, '/api/auth/login', { method: 'POST', body: { username, password } });

/** 连接 socket 并收集它收到的每一次 users:online */
function connect(base, token) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const socket = io(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('users:online', (list) => seen.push(list));
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
    socket.on('state:init', () => { clearTimeout(timer); resolve({ socket, seen }); });
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
  });
}

// ---------------------------------------------------------------
async function main() {
  console.log(`隔离目录：${TMP}`);
  console.log(`局域网 IP：${THE_LAN_IP || '(无，部分断言将跳过)'}`);

  // ============================================================
  section('1. 监听地址（F-02）：config.yaml 写什么就绑什么，缺省回环');
  {
    const { file } = makeConfig('nohost', { port: 1 });
    // 去掉 host 行 → 走 config.js 的兜底默认值
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^ {2}host: 127\.0\.0\.1\n/m, ''), 'utf8');
    const probe = (cfg) => execFileSync(process.execPath, ['-e', "console.log(require('./src/config').HOST)"], {
      cwd: SERVER_ROOT, env: { ...process.env, APP_CONFIG: cfg }, encoding: 'utf8'
    }).trim();
    const noHost = probe(file);
    ok(noHost === '127.0.0.1', '缺省 host（配置里没写）→ 回环 127.0.0.1', noHost);
    const shippedHost = probe(path.join(SERVER_ROOT, 'config.yaml'));
    ok(shippedHost === '127.0.0.1', '现行 config.yaml 的 server.host = 127.0.0.1', shippedHost);

    const port = await pickPort(3013);
    const c = makeConfig('loopback', { port, host: '127.0.0.1' });
    await startServer('loopback', c.file, port);
    const local = await api(`http://127.0.0.1:${port}`, '/health');
    ok(local.status === 200, '回环可访问 /health');
    if (THE_LAN_IP) {
      let blocked = false;
      try { await api(`http://${THE_LAN_IP}:${port}`, '/health'); }
      catch { blocked = true; }
      ok(blocked, `后端不监听局域网地址 ${THE_LAN_IP}:${port}（直连被拒）`);
    }
  }

  // ============================================================
  section('2. 密钥 IP 绑定（F-03）：boundIp 不一致必须拒绝');
  let baseA = null;
  {
    if (!THE_LAN_IP) {
      console.log('  （无局域网 IP，跳过本节）');
    } else {
      const portA = await pickPort(3011);
      // 需要两个不同的**真实**来源 IP → 这一个实例绑 0.0.0.0（临时空库，数秒即销毁）
      const c = makeConfig('a', { port: portA, host: '0.0.0.0', perIp: 100, perAccount: 10 });
      await startServer('a', c.file, portA);
      baseA = `http://127.0.0.1:${portA}`;
      const baseLan = `http://${THE_LAN_IP}:${portA}`;

      // ---- 从回环申请、从局域网使用 ----
      const u1 = await register(baseA, `sec1_${TS}_a`);
      const k1 = await api(baseA, '/api/keys', { method: 'POST', token: u1.data.token, body: { name: 'loopback-key' } });
      ok(k1.status === 201, '回环侧申请密钥成功');
      ok(k1.data?.boundIp === '127.0.0.1', '创建响应里的 boundIp = 127.0.0.1', k1.data?.boundIp);

      const sameIp = await api(baseA, '/api/v1/state', { key: k1.data.key });
      ok(sameIp.status === 200, '同一 IP 使用 → 200');

      const otherIp = await api(baseLan, '/api/v1/state', { key: k1.data.key });
      ok(otherIp.status === 403, `换一个真实来源 IP（${THE_LAN_IP}）使用 → 403`, otherIp.data);

      // ---- 反向：从局域网申请、从回环使用 ----
      const u2 = await register(baseLan, `sec2_${TS}_b`);
      const k2 = await api(baseLan, '/api/keys', { method: 'POST', token: u2.data.token, body: { name: 'lan-key' } });
      ok(k2.status === 201 && k2.data?.boundIp === THE_LAN_IP, '局域网侧申请到的密钥绑定真实客户端 IP', k2.data?.boundIp);
      const k2Back = await api(baseA, '/api/v1/state', { key: k2.data.key });
      ok(k2Back.status === 403, '该密钥改从回环使用 → 403（双向都拦）', k2Back.data);

      // ---- 伪造 X-Forwarded-For 不能绕过（直连部署 trust_proxy=false） ----
      const spoof = await api(baseA, '/api/v1/state', {
        key: k1.data.key, headers: { 'X-Forwarded-For': '8.8.8.8' }
      });
      ok(spoof.status === 200, '伪造 XFF 在 trust_proxy=false 下被忽略（来源仍按 TCP 对端算）', spoof.data);

      // ---- [CHANGED] 老库遗留密钥（bound_ip 为 NULL）：不再「首次使用就地补写」 ----
      //   原行为会让窃取者抢先把密钥绑到自己的 IP，把合法用户反锁在外。
      //   新策略：缺绑定的密钥一律 403，要求撤销后重新申请。
      const db = new DatabaseSync(path.join(TMP, 'a.db'));
      db.prepare('UPDATE api_keys SET bound_ip = NULL WHERE id = ?').run(k1.data.id);
      db.close();
      const adopted = await api(baseA, '/api/v1/state', { key: k1.data.key });
      ok(adopted.status === 403 && /缺少 IP 绑定/.test(adopted.data?.error || ''),
        '遗留 NULL 绑定密钥被拒绝（403 + 提示重新申请），不被首个使用者抢占', adopted.data);
    }
  }

  // ============================================================
  section('3. 登录失败限流（F-04）：账号维度 + 成功即清零');
  if (baseA) {
    // 实例 A：max_per_account 用出厂的 10，max_per_ip 放宽到 100 以隔离两个维度
    const victim = `sec1_${TS}_a`;
    const results = [];
    for (let i = 0; i < 10; i++) results.push((await login(baseA, victim, 'wrong-password')).status);
    ok(results.every((s) => s === 401), '前 10 次错误密码均为 401', results);

    const eleventh = await login(baseA, victim, 'wrong-password');
    ok(eleventh.status === 429, '第 11 次 → 429（账号维度触发）', eleventh.data);
    ok(Number(eleventh.retryAfter) > 0, '429 带 Retry-After 头', eleventh.retryAfter);

    const other = await login(baseA, `sec2_${TS}_b`, 'wrong-password');
    ok(other.status === 401, '另一个账号不受影响（不是全局封锁）', other.data);

    // 成功登录必须清掉该账号的失败计数
    const fresh = `sec1_${TS}_reset`;
    await register(baseA, fresh, 'pass1234');
    for (let i = 0; i < 5; i++) await login(baseA, fresh, 'wrong');
    const good = await login(baseA, fresh, 'pass1234');
    ok(good.status === 200, '第 6 次用正确密码登录成功（成功本身也应被允许）', good.data);
    const afterReset = [];
    for (let i = 0; i < 10; i++) afterReset.push((await login(baseA, fresh, 'wrong')).status);
    ok(afterReset.every((s) => s === 401),
      '成功登录后计数已清零：再错 10 次仍是 401（未清零则第 5 次就会 429）', afterReset);
  } else {
    console.log('  （实例 A 未启动，跳过）');
  }

  // ============================================================
  section('4. 登录失败限流（F-04）：IP 维度');
  {
    const port = await pickPort(3012);
    const c = makeConfig('b', { port, perIp: 3, perAccount: 100 });
    await startServer('b', c.file, port);
    const base = `http://127.0.0.1:${port}`;

    const s = [];
    s.push((await login(base, `nonexistent_${TS}_1`, 'x')).status);
    s.push((await login(base, `nonexistent_${TS}_2`, 'x')).status);
    s.push((await login(base, `nonexistent_${TS}_3`, 'x')).status);
    ok(s.every((x) => x === 401), '前 3 次（三个不同用户名）均 401', s);

    const fourth = await login(base, `nonexistent_${TS}_4`, 'x');
    ok(fourth.status === 429, '第 4 次 → 429（同一 IP 触发，与用户名无关）', fourth.data);
  }

  // ============================================================
  section('5. 在线列表可见范围（F-05）：非好友不可见 + 不下发 username');
  if (baseA) {
    const base = baseA;
    // 前面的断言已把 127.0.0.1 这条 IP 绑定占掉（同一 IP 只能绑一个用户），
    // 这里直接清掉临时库里的绑定记录，让本节能重新申请密钥。
    {
      const db = new DatabaseSync(path.join(TMP, 'a.db'));
      db.prepare('DELETE FROM apikey_ip_claims').run();
      db.close();
    }
    const P = await register(base, `sec5_${TS}_p`);
    const R = await register(base, `sec5_${TS}_r`);
    const S = await register(base, `sec5_${TS}_s`);

    // P 与 R 建立好友关系
    await api(base, '/api/friends/requests', { method: 'POST', token: P.data.token, body: { username: R.data.user.username } });
    const reqs = await api(base, '/api/friends/requests', { token: R.data.token });
    const rid = reqs.data?.received?.[0]?.id;
    await api(base, `/api/friends/requests/${rid}/accept`, { method: 'POST', token: R.data.token, body: {} });

    const cp = await connect(base, P.data.token);
    const cr = await connect(base, R.data.token);
    const cs = await connect(base, S.data.token);
    await sleep(600);

    const last = cp.seen[cp.seen.length - 1] || [];
    const ids = last.map((u) => u.id);
    ok(ids.includes(P.data.user.id), '列表含自己');
    ok(ids.includes(R.data.user.id), '列表含好友 R');
    ok(!ids.includes(S.data.user.id), '列表不含陌生人 S（原先返回全站在线用户）', ids);
    ok(last.length > 0 && last.every((u) => !('username' in u) && 'nickname' in u && 'avatar' in u),
      '条目只有 id/nickname/avatar，不含 username', last[0]);

    // REST（API 密钥通道）同样受限
    const key = await api(base, '/api/keys', { method: 'POST', token: P.data.token, body: { name: 'presence' } });
    const st = await api(base, '/api/v1/state', { key: key.data.key });
    const stIds = (st.data?.online || []).map((u) => u.id);
    ok(stIds.includes(R.data.user.id) && !stIds.includes(S.data.user.id),
      '/api/v1/state 的 online 同样按关系收敛', stIds);

    // 同群成员也该可见（群聊需要知道群成员在线与否）。
    // 注意 createGroup / invite 都只允许拉**好友**，所以要让 P 与 S 变成
    // 「同群但非好友」，必须借共同好友 R 的手：先让 S 与 R 成为好友，
    // 再由 R 建群把 P、S 一起拉进去。
    await api(base, '/api/friends/requests', { method: 'POST', token: S.data.token, body: { username: R.data.user.username } });
    const sReqs = await api(base, '/api/friends/requests', { token: R.data.token });
    const sRid = sReqs.data?.received?.[0]?.id;
    await api(base, `/api/friends/requests/${sRid}/accept`, { method: 'POST', token: R.data.token, body: {} });

    const g = await api(base, '/api/groups', {
      method: 'POST', token: R.data.token,
      body: { name: `sec群${TS}`, memberIds: [P.data.user.id, S.data.user.id] }
    });
    ok(g.status === 200 && !!g.data?.groupId, 'R 建群并把 P、S 一起拉进去（P 与 S 仍非好友）', g.data);

    // 建群不会触发在线广播，重连一次让每个客户端拿到最新可见列表
    cs.socket.disconnect();
    const cs2 = await connect(base, S.data.token);
    await sleep(600);
    const last2 = cp.seen[cp.seen.length - 1] || [];
    const ids2 = last2.map((u) => u.id);
    ok(ids2.includes(S.data.user.id), '同群之后 S 变为可见（P 与 S 并非好友）', ids2);

    cp.socket.disconnect(); cr.socket.disconnect(); cs2.socket.disconnect();
  } else {
    console.log('  （实例 A 未启动，跳过）');
  }

  // ============================================================
  section('6. presence.scope 兼容开关');
  {
    const c = makeConfig('scope', { port: 1, scope: 'all' });
    const probe = (cfg) => execFileSync(process.execPath, ['-e', "console.log(require('./src/config').PRESENCE_SCOPE)"], {
      cwd: SERVER_ROOT, env: { ...process.env, APP_CONFIG: cfg }, encoding: 'utf8'
    }).trim();
    const shipped = probe(path.join(SERVER_ROOT, 'config.yaml'));
    ok(shipped === 'related', '出厂配置 = related（默认收敛）', shipped);
    const all = probe(c.file);
    ok(all === 'all', 'security.presence.scope: all 可回到旧行为（逃生开关有效）', all);
  }

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  return failed;
}

let exitCode = 1;
try {
  exitCode = (await main()) === 0 ? 0 : 1;
} catch (err) {
  console.error('\n安全回归异常：', err);
  exitCode = 1;
} finally {
  stopAll();
  await sleep(400);
  // 释放 sqlite 句柄后删隔离目录
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
    catch { await sleep(300); }
  }
  console.log(`已清理隔离目录：${TMP}`);
}
process.exit(exitCode);
