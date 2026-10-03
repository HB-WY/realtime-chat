// scripts/plugin_check.mjs
//
// 插件系统自包含回归。
//
// 覆盖 8 个链路：
//   1. 上传 .plugin（含 manifest 校验）
//   2. 安装 / 权限授权 / 卸载
//   3. 入口 / 资源的**票据机制**（iframe 无法带 Authorization 头）
//   4. 桥侧 KV 存储（读写删 + 配额）
//   5. 支付：宿主确认框 → 服务端事务；幂等；上限；余额不足
//   6. 退款：自助 + 越权拒绝
//   7. 分享码 / 订阅
//   8. 边界：路径穿越、权限不足、金额非法
//
// 自包含：临时配置 + 临时空库 + 隔离端口，跑完删干净。
//
// 用法：cd server && node scripts/plugin_check.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plgcheck-'));
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

// ============================================================
// 打包一个最小插件（用于上传）
//
// permissions 里必须**包含测试过程中要授权的所有权限** ——
//   服务端会拒绝"授权未声明的权限"，这是安全特性，不是 bug。
// ============================================================
function buildPlugin(id, extra = {}) {
  const manifest = {
    id,
    name: `测试插件 ${id}`,
    version: '1.0.0',
    description: '回归用',
    entry: 'index.html',
    permissions: [
      'user:read',
      'storage',
      'ui:toast',
      'ui:close',
      'payment:request',
      'message:send'
    ],
    maxPayment: 500,
    ...extra
  };
  const files = {
    'index.html': `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>${id}</h1></body></html>`,
    'app.js': `console.log('${id} loaded');`
  };
  return Buffer.from(JSON.stringify({ manifest, files }), 'utf8');
}

// ============================================================
// 起隔离实例
// ============================================================
const port = await freePort(3061);
const cfgFile = path.join(TMP, 'plg.yaml');
const uploadRoot = path.join(TMP, 'uploads').replace(/\\/g, '/');
const dbPath = path.join(TMP, 'plg.db');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${dbPath.replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${uploadRoot}`), 'utf8');

const logFile = path.join(TMP, 'plg.log');
const fd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined, SERVE_CLIENT: '0' },
  stdio: ['ignore', fd, fd]
});

const BASE = `http://127.0.0.1:${port}`;

// ============================================================
// HTTP 工具
//
// [FIX] api() 自动补 /api 前缀：调用方写 '/plugins/xxx' 或
//   '/api/plugins/xxx' 都行。早先脚本里所有请求路径混用两种风格，
//   而 '/admin/plugins/payments' 和 '/admin/plugins/:id/delist' 两处
//   忘了写 '/api' → 打到 http://host:port/admin/... → 404，
//   表现为"管理员列表为空 / 下架返回 404"。
//   由调用方保证前缀太脆弱，改成函数里统一兜底。
// ============================================================
async function api(p, { method = 'GET', token, body, form } = {}) {
  const url = BASE + (p.startsWith('/api/') ? p : '/api' + p);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, raw: text.slice(0, 300) };
}

async function uploadPlugin(token, buf, filename = 'test.plugin', opts = {}) {
  const fd = new FormData();
  fd.append('bundle', new Blob([buf], { type: 'application/json' }), filename);
  if (opts.isPublic) fd.append('isPublic', '1');
  const res = await fetch(`${BASE}/api/plugins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, data };
}

// ============================================================
// 主流程
// ============================================================
let exitCode = 1;
try {
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`实例启动失败：\n${fs.readFileSync(logFile, 'utf8')}`);

  // ============================================================
  section('0. 准备账号（A=作者，B=用户，C=管理员）');
  const A = {};
  const B = {};
  const C = {};
  for (const [who, holder] of [['a', A], ['b', B], ['c', C]]) {
    const username = `plg_${TS}_${who}`;
    const r = await api('/auth/register', {
      method: 'POST',
      body: { username, password: 'pass1234', nickname: `插件${who.toUpperCase()}` }
    });
    holder.username = username;
    holder.token = r.data?.token;
    holder.id = r.data?.user?.id;
    ok(r.status === 200 && !!holder.token, `注册 ${username}`, r.data);
  }
  // C 提权 admin（用于下架与强制退款）
  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(C.id);
    db.close();
    ok(true, 'C 已提权为 admin');
  }
  // 给 B 更多积分（便于测试支付）
  {
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE user_points SET balance = 5000 WHERE user_id = ?').run(B.id);
    db.close();
    ok(true, 'B 的余额设为 5000（便于支付测试）');
  }

  // ============================================================
  section('1. 上传插件（manifest 校验）');
  let pluginId = `hello-${TS}`;
  {
    // 1.1 正常上传
    const buf = buildPlugin(pluginId);
    const r = await uploadPlugin(A.token, buf);
    ok(r.status === 200 && r.data?.ok, '上传合法插件成功', r.data);
    ok(r.data?.plugin?.id === pluginId, '返回的插件 id 与 manifest 一致');
    ok(r.data?.plugin?.version === '1.0.0', '返回版本号');
    ok((r.data?.plugin?.permissions || []).includes('payment:request'),
      '权限列表含 payment:request');

    // 1.2 非法 manifest：id 带大写
    const bad1 = buildPlugin(pluginId + '-BAD', { id: 'BadName' });
    const r1 = await uploadPlugin(A.token, bad1, 'bad1.plugin');
    ok(r1.status === 400 && /id 不合法/.test(r1.data?.error || ''),
      '【校验】id 不合法被拒', r1.data);

    // 1.3 非法 manifest：未知权限
    const bad2 = buildPlugin(pluginId + '-bad2', { permissions: ['nuke:everything'] });
    const r2 = await uploadPlugin(A.token, bad2, 'bad2.plugin');
    ok(r2.status === 400 && /未知权限/.test(r2.data?.error || ''),
      '【校验】未知权限被拒', r2.data);

    // 1.4 非法 manifest：entry 不在 files 里
    const bad3 = JSON.parse(buildPlugin(pluginId + '-bad3').toString('utf8'));
    delete bad3.files['index.html'];
    const r3 = await uploadPlugin(A.token, Buffer.from(JSON.stringify(bad3)), 'bad3.plugin');
    ok(r3.status === 400 && /不在 files/.test(r3.data?.error || ''),
      '【校验】entry 不在 files 里被拒', r3.data);

    // 1.5 非法文件名：.. 路径穿越
    const bad4 = JSON.parse(buildPlugin(pluginId + '-bad4').toString('utf8'));
    bad4.files['../evil.js'] = 'alert(1)';
    const r4 = await uploadPlugin(A.token, Buffer.from(JSON.stringify(bad4)), 'bad4.plugin');
    ok(r4.status === 400 && /路径不合法/.test(r4.data?.error || ''),
      '【安全】.. 路径穿越被拒', r4.data);
  }

  // ============================================================
  section('2. 未安装时：不能读入口 / 不能调 KV');
  {
    // 2.1 未登录
    const anon = await api(`/plugins/${pluginId}/entry`);
    ok(anon.status === 401, '【安全】未登录读 entry → 401', anon.status);

    // 2.2 登录但未安装
    const notInstalled = await api(`/plugins/${pluginId}/entry`, { token: B.token });
    ok(notInstalled.status === 403, '【安全】未安装读 entry → 403', notInstalled.status);

    // 2.3 未安装时申请票据也被拒
    const noTicket = await api(`/plugins/${pluginId}/ticket`, { method: 'POST', token: B.token, body: {} });
    ok(noTicket.status === 403, '【安全】未安装申请票据 → 403', noTicket.status);

    // 2.4 未安装时 KV 被拒
    const kvDenied = await api(`/plugins/${pluginId}/kv`, { token: B.token });
    ok(kvDenied.status === 403, '【安全】未安装读 KV → 403', kvDenied.status);
  }

  // ============================================================
  section('3. 安装 / 权限授权 / 卸载');
  {
    // 3.1 未公开的插件，别人不能安装
    const denied = await api(`/plugins/${pluginId}/install`, {
      method: 'POST', token: B.token, body: { grantedPerms: [] }
    });
    ok(denied.status === 403, '【权限】未公开插件他人不能安装 → 403', denied.data);

    // 3.2 A（作者）分享
    const share = await api(`/plugins/${pluginId}/share`, {
      method: 'POST', token: A.token, body: {}
    });
    ok(share.status === 200 && share.data?.shareCode, '作者生成分享码', share.data);

    // 3.3 B 凭分享码订阅
    const sub = await api('/plugins/subscribe', {
      method: 'POST', token: B.token, body: { code: share.data.shareCode }
    });
    ok(sub.status === 200 && sub.data?.plugin?.installed === true,
      'B 凭分享码订阅成功并已安装', sub.data);

    // 3.4 尝试授权未声明的权限 → 拒
    const bad = await api(`/plugins/${pluginId}/install`, {
      method: 'POST', token: B.token,
      body: { grantedPerms: ['user:read', 'room:list'] }   // room:list 不在 manifest 里
    });
    ok(bad.status === 400 && /未声明/.test(bad.data?.error || ''),
      '【权限】无法授权未声明的权限', bad.data);

    // 3.5 更新授权（撤销 payment:request）
    const up = await api(`/plugins/${pluginId}/install`, {
      method: 'POST', token: B.token,
      body: { grantedPerms: ['user:read', 'storage', 'ui:toast', 'ui:close'] }
    });
    ok(up.status === 200, '更新授权列表', up.data);
    ok(!(up.data?.plugin?.grantedPerms || []).includes('payment:request'),
      'payment:request 已被撤销', up.data?.plugin?.grantedPerms);

    // 3.6 重新授权（恢复完整权限，供后续支付测试）
    //   注意：grantedPerms 必须全部包含在 manifest.permissions 里，
    //   否则会被服务端拒（安全特性：不能授权未声明的权限）。
    const up2 = await api(`/plugins/${pluginId}/install`, {
      method: 'POST', token: B.token,
      body: {
        grantedPerms: [
          'user:read',
          'storage',
          'ui:toast',
          'ui:close',
          'payment:request',
          'message:send'
        ]
      }
    });
    ok(up2.status === 200, '重新授权完整权限', up2.data);
  }

  // ============================================================
  section('4. 加载票据 + 入口 / 资源');
  let ticket = null;
  {
    // 4.1 申请票据
    const t = await api(`/plugins/${pluginId}/ticket`, {
      method: 'POST', token: B.token, body: {}
    });
    ok(t.status === 200 && typeof t.data?.ticket === 'string',
      '已安装用户可申请票据', t.data);
    ticket = t.data.ticket;

    // 4.2 带票据读入口 —— 无 Authorization 头！
    const entryRes = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${ticket}`);
    const html = await entryRes.text();
    ok(entryRes.status === 200, '【票据】无 token 带票据读 entry → 200', entryRes.status);
    ok(/data-injected="host-api"/.test(html), '【关键】服务端已注入桥脚本');
    ok(/<h1>/.test(html), '返回的是插件 HTML 内容');

    // 4.3 带票据读资源
    const assetRes = await fetch(`${BASE}/api/plugins/${pluginId}/asset?t=${ticket}&path=app.js`);
    const js = await assetRes.text();
    ok(assetRes.status === 200 && /loaded/.test(js),
      '【票据】读 app.js 正常', js.slice(0, 50));

    // 4.4 路径穿越
    const trav = await fetch(`${BASE}/api/plugins/${pluginId}/asset?t=${ticket}&path=${encodeURIComponent('../evil.js')}`);
    ok(trav.status === 400, '【安全】路径穿越被拒 → 400', trav.status);

    // 4.5 用别人的票据
    const tA = await api(`/plugins/${pluginId}/ticket`, {
      method: 'POST', token: A.token, body: {}
    });
    const crossToken = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${tA.data.ticket}`);
    // A 是作者，也应该能访问
    ok(crossToken.status === 200, '【票据】作者本人票据也有效');

    // 4.6 无效票据
    const bad = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=deadbeef`);
    ok(bad.status === 401, '【票据】无效票据 → 401', bad.status);

    // 4.7 篡改插件 id（票据绑定插件）
    const other = `other-${TS}`;
    const otherBuf = buildPlugin(other);
    await uploadPlugin(A.token, otherBuf);
    const wrong = await fetch(`${BASE}/api/plugins/${other}/entry?t=${ticket}`);
    ok(wrong.status === 401, '【票据】票据不能跨插件使用 → 401', wrong.status);

    // 4.8 校验响应头
    const res2 = await fetch(`${BASE}/api/plugins/${pluginId}/entry?t=${ticket}`);
    const csp = res2.headers.get('content-security-policy') || '';
    ok(/connect-src 'none'/.test(csp), '【安全】CSP 禁止插件发起外部请求');
    ok(res2.headers.get('cache-control') === 'no-store', '入口响应禁止缓存');
  }

  // ============================================================
  section('5. KV 存储');
  {
    // 5.1 写
    const set = await api(`/plugins/${pluginId}/kv`, {
      method: 'POST', token: B.token, body: { key: 'counter', value: '42' }
    });
    ok(set.status === 200 && set.data?.item?.value === '42', '【KV】写入 42', set.data);

    // 5.2 读
    const get = await api(`/plugins/${pluginId}/kv`, { token: B.token });
    const item = (get.data?.items || []).find((i) => i.key === 'counter');
    ok(item?.value === '42', '【KV】读回 42', item);
    ok(get.data?.usage?.used > 0, '【KV】用量统计', get.data?.usage);

    // 5.3 用户隔离：A 的 KV 里没有这条
    const getA = await api(`/plugins/${pluginId}/kv`, { token: A.token });
    const itemA = (getA.data?.items || []).find((i) => i.key === 'counter');
    ok(!itemA, '【KV】用户 A 看不到 B 的数据');

    // 5.4 更新（应覆盖）
    await api(`/plugins/${pluginId}/kv`, {
      method: 'POST', token: B.token, body: { key: 'counter', value: '100' }
    });
    const get2 = await api(`/plugins/${pluginId}/kv`, { token: B.token });
    const item2 = (get2.data?.items || []).find((i) => i.key === 'counter');
    ok(item2?.value === '100', '【KV】更新覆盖成功', item2?.value);

    // 5.5 删
    const del = await api(`/plugins/${pluginId}/kv/counter`, {
      method: 'DELETE', token: B.token
    });
    ok(del.status === 200, '【KV】删除成功');
    const get3 = await api(`/plugins/${pluginId}/kv`, { token: B.token });
    ok(!(get3.data?.items || []).some((i) => i.key === 'counter'),
      '【KV】删除后确实没了');

    // 5.6 单 value 超限
    const huge = 'x'.repeat(20000);
    const over = await api(`/plugins/${pluginId}/kv`, {
      method: 'POST', token: B.token, body: { key: 'big', value: huge }
    });
    ok(over.status === 400 && /字节/.test(over.data?.error || ''),
      '【KV】单 value 超限被拒', over.data);
  }

  // ============================================================
  section('6. 支付');
  let paymentId = null;
  const orderId = `order-${TS}-1`;
  {
    // 6.1 余额不足场景：先把 B 的余额砍到 5，再用 10 分测试
    {
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE user_points SET balance = 5 WHERE user_id = ?').run(B.id);
      db.close();
    }
    const payInsufficient = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 10, subject: '测试', orderId }
    });
    ok(payInsufficient.status === 400 && /不足/.test(payInsufficient.data?.error || ''),
      '【支付】余额不足被拒', payInsufficient.data);

    // 6.2 恢复余额
    {
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE user_points SET balance = 5000 WHERE user_id = ?').run(B.id);
      db.close();
    }

    // 6.3 pay-info 查询
    const info = await api(`/plugins/${pluginId}/pay-info?amount=10`, { token: B.token });
    ok(info.status === 200, '【支付】pay-info 查询成功', info.data);
    ok(info.data?.singleMax === 500, '【支付】单次上限 = manifest.maxPayment', info.data?.singleMax);
    ok(info.data?.valid === true, '【支付】校验通过', info.data?.reason);
    ok(info.data?.balance >= 5000, '【支付】返回当前余额');

    // 6.4 正常支付
    const pay = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 10, subject: '解锁专业版', orderId, metadata: { level: 1 } }
    });
    ok(pay.status === 200 && pay.data?.ok, '【支付】正常支付成功', pay.data);
    paymentId = pay.data?.payment?.id;
    ok(pay.data?.payment?.amount === 10, '【支付】金额 10');
    ok(pay.data?.payment?.status === 'paid', '【支付】状态 paid');
    ok(typeof pay.data?.payment?.transactionId === 'string', '【支付】有事务 id');
    ok(pay.data?.balance === 4990, '【支付】买家余额 5000 → 4990', pay.data?.balance);

    // 6.5 幂等：同一 orderId 再发一次 → 不重复扣
    const again = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 10, subject: '解锁专业版', orderId, metadata: { level: 1 } }
    });
    ok(again.status === 200 && again.data?.alreadyPaid === true,
      '【支付】幂等：同一 orderId 不重复扣', again.data);
    ok(again.data?.balance === 4990, '【支付】幂等后余额不变');

    // 6.6 卖家收到了钱（用可选链，避免 payments 为空时崩）
    const seller = await api('/plugins/payments/seller', { token: A.token });
    ok((seller.data?.payments || []).length === 1,
      '【支付】卖家看到 1 笔收款', seller.data?.payments?.length);
    ok(seller.data?.payments?.[0]?.amount === 10, '【支付】卖家金额 10');

    // 6.7 单次超上限
    const tooMuch = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 501, subject: '超限', orderId: `over-${TS}` }
    });
    ok(tooMuch.status === 400 && /不能超过/.test(tooMuch.data?.error || ''),
      '【支付】单次超上限被拒', tooMuch.data);

    // 6.8 给自己付费
    const self = await api('/plugins/payments', {
      method: 'POST', token: A.token,
      body: { pluginId, amount: 10, subject: '自己', orderId: `self-${TS}` }
    });
    ok(self.status === 400 && /自己/.test(self.data?.error || ''),
      '【支付】不能给自己付费', self.data);

    // 6.9 参数非法
    const badAmount = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: -1, subject: 'x', orderId: `neg-${TS}` }
    });
    ok(badAmount.status === 400, '【支付】负数金额被拒', badAmount.data);

    const badOrderId = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 10, subject: 'x', orderId: '带 空格 的' }
    });
    ok(badOrderId.status === 400, '【支付】非法 orderId 被拒', badOrderId.data);

    // 6.10 未安装者不能支付
    const notInstalled = await api('/plugins/payments', {
      method: 'POST', token: C.token,
      body: { pluginId, amount: 10, subject: 'x', orderId: `ni-${TS}` }
    });
    ok(notInstalled.status === 403, '【支付】未安装不能支付 → 403', notInstalled.data);
  }

  // ============================================================
  section('7. 退款');
  {
    // 7.1 买家自助退款
    const refund = await api(`/plugins/payments/${paymentId}/refund`, {
      method: 'POST', token: B.token, body: { reason: '不想要了' }
    });
    ok(refund.status === 200 && refund.data?.payment?.status === 'refunded',
      '【退款】买家自助退款成功', refund.data);
    ok(refund.data?.balance === 5000, '【退款】买家余额恢复 5000', refund.data?.balance);

    // 7.2 已退款再退 → 拒
    const again = await api(`/plugins/payments/${paymentId}/refund`, {
      method: 'POST', token: B.token, body: { reason: '再来一次' }
    });
    ok(again.status === 400 && /不可退款/.test(again.data?.error || ''),
      '【退款】已退款的记录不能再退', again.data);

    // 7.3 管理员强制退款（管理员不受窗口限制）
    const pay2 = await api('/plugins/payments', {
      method: 'POST', token: B.token,
      body: { pluginId, amount: 20, subject: '再买', orderId: `order-${TS}-2` }
    });
    const pid2 = pay2.data?.payment?.id;
    const byOther = await api(`/plugins/payments/${pid2}/refund`, {
      method: 'POST', token: C.token, body: {}
    });
    // C 是管理员，所以能退
    ok(byOther.status === 200, '【退款】管理员强制退款成功', byOther.data);

    // 7.4 管理员列表
    //   [FIX] 加上 HTTP 状态码，将来失败时能直接看到是 404 还是别的
    const adminList = await api('/admin/plugins/payments', { token: C.token });
    ok((adminList.data?.payments || []).length >= 2,
      `【退款】管理员全量列表（HTTP ${adminList.status}）`,
      adminList.data);
  }

  // ============================================================
  section('8. 作者营收 / 分享 / 权限边界');
  {
    // 8.1 作者看自己插件的营收
    const stats = await api(`/plugins/${pluginId}/pay-stats`, { token: A.token });
    ok(stats.status === 200, '作者可查营收', stats.data);
    ok(typeof stats.data?.paidCount === 'number', '返回 paidCount');

    // 8.2 非作者不能查
    const denied = await api(`/plugins/${pluginId}/pay-stats`, { token: B.token });
    ok(denied.status === 403, '非作者查营收 → 403', denied.status);

    // 8.3 非作者不能下架（C 是 admin，能；B 是普通用户，不能）
    //   [FIX] 加上 HTTP 状态码，失败时能直接看到是 404 还是别的
    const delistB = await api(`/admin/plugins/${pluginId}/delist`, {
      method: 'POST', token: B.token, body: { reason: 'x' }
    });
    ok(delistB.status === 403,
      `【权限】普通用户下架 → 403（实际 ${delistB.status}）`,
      delistB.data);

    // 8.4 非作者不能改别人的插件可见性
    const setPriv = await api(`/plugins/${pluginId}/private`, {
      method: 'POST', token: B.token, body: {}
    });
    ok(setPriv.status === 403, '【权限】非作者改可见性 → 403', setPriv.status);

    // 8.5 卸载后：KV 被清、票据作废、entry 拒绝
    const un = await api(`/plugins/${pluginId}/uninstall`, {
      method: 'DELETE', token: B.token
    });
    ok(un.status === 200, '【卸载】成功');
    const kvAfter = await api(`/plugins/${pluginId}/kv`, { token: B.token });
    ok(kvAfter.status === 403, '【卸载】卸载后 KV 被拒 → 403');
    const entryAfter = await api(`/plugins/${pluginId}/entry`, { token: B.token });
    ok(entryAfter.status === 403, '【卸载】卸载后 entry 被拒 → 403');
  }

  // ============================================================
  section('9. 收尾');
  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(C.id);
    db.close();
    ok(true, '已还原 C 的角色');
  }

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n插件专项回归异常：', err);
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