// scripts/sticker_pack_check.mjs
//
// 表情包「独立库 + 购买入库 + 聊天使用」专项回归。
//
// 覆盖四条关键链路（此前几套回归都没覆盖，是本次改动最大的部分）：
//
//   1. 表情独立库：上传表情 → 落盘 custom/{uid}/sticker/，
//      **不写 assets 表** → /api/assets 看不到它们
//   2. 表情包商品：/shop/download 与 /shop/preview **都拒绝**（403）
//      —— 卖家 / 管理员 / 普通用户，任何角色都不放行
//   3. 购买入库：买家拿到 grantedPackId，整包（含文件）复制进买家
//      自己的表情库，可读可用
//   4. lookupByUrl：给定 fileUrl 反查「属于哪个包 / 我拥有还是需要购买」
//      —— 这是聊天界面右键菜单分流的服务端依据
//
// 自包含：临时配置 + 临时空库 + 临时上传目录 + 隔离端口，
// 跑完杀掉并删干净。不碰 chat.db，也不写 uploads/。
//
// 用法：cd server && node scripts/sticker_pack_check.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stkcheck-'));
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
// 1x1 PNG（尾部追加本次运行的时间戳，保证每轮 sha 不同）
// ============================================================
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
function png(tag = '') {
  return Buffer.concat([PNG_1x1, Buffer.from(`#${TS}:${tag}`)]);
}

// ============================================================
// 起隔离实例
// ============================================================
const port = await freePort(3051);
const cfgFile = path.join(TMP, 'stk.yaml');
const uploadRoot = path.join(TMP, 'uploads').replace(/\\/g, '/');
const dbPath = path.join(TMP, 'stk.db');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${dbPath.replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${uploadRoot}`), 'utf8');

const logFile = path.join(TMP, 'stk.log');
const fd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined, SERVE_CLIENT: '0' },
  stdio: ['ignore', fd, fd]
});

const BASE = `http://127.0.0.1:${port}`;
const CUSTOM_DIR = path.join(TMP, 'uploads', 'custom');

// ============================================================
// HTTP 工具
// ============================================================
async function api(p, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, raw: text.slice(0, 200) };
}

/** 上传单张图片到某入口（field 可指定，默认 'file'） */
async function uploadPng(apiPath, token, buf, name, field = 'file', extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  fd.append(field, new Blob([buf], { type: 'image/png' }), name);
  const res = await fetch(BASE + apiPath, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, data };
}

/** 上传多张图片（同一字段多次） */
async function uploadPngs(apiPath, token, files, field = 'files') {
  const fd = new FormData();
  for (const f of files) {
    fd.append(field, new Blob([f.buf], { type: 'image/png' }), f.name);
  }
  const res = await fetch(BASE + apiPath, {
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
  section('0. 准备账号（A=卖家/管理员，B=买家，C=路人）');
  const A = {};
  const B = {};
  const C = {};
  {
    for (const [who, holder] of [['a', A], ['b', B], ['c', C]]) {
      const username = `stk_${TS}_${who}`;
      const r = await api('/api/auth/register', {
        method: 'POST',
        body: { username, password: 'pass1234', nickname: `表情包${who.toUpperCase()}` }
      });
      holder.username = username;
      holder.token = r.data?.token;
      holder.id = r.data?.user?.id;
      ok(r.status === 200 && !!holder.token, `注册 ${username}`, r.data);
    }
    // A 提权 admin（上架商品需要 list_products，50 级）
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(A.id);
    db.close();
    ok(true, 'A 已提权为 admin（用于上架商品）');
  }

  // ============================================================
  section('1. 表情独立库：上传的表情不写 assets 表');
  let packId = null;
  let stickerUrls = [];
  {
    const create = await api('/api/stickers/packs', {
      method: 'POST', token: A.token,
      body: { name: `独立库验证${TS}`, description: '检查是否污染资源池' }
    });
    ok(create.status === 201 && create.data?.pack?.id > 0, 'A 创建表情包', create.data);
    packId = create.data.pack.id;

    const up = await uploadPngs(
      `/api/stickers/packs/${packId}/items`, A.token,
      [
        { name: 's1.png', buf: png('s1') },
        { name: 's2.png', buf: png('s2') },
        { name: 's3.png', buf: png('s3') }
      ]
    );
    ok(up.status === 200 && up.data?.created === 3, '上传 3 张表情', up.data);
    stickerUrls = (up.data?.items || []).map((i) => i.url);
    ok(stickerUrls.every((u) => u.startsWith(`/uploads/custom/${A.id}/sticker/`)),
      '表情落盘在 custom/{uid}/sticker/ 独立目录', stickerUrls);

    // 文件系统核对
    const stickerDir = path.join(CUSTOM_DIR, String(A.id), 'sticker');
    const filesOnDisk = fs.existsSync(stickerDir) ? fs.readdirSync(stickerDir) : [];
    ok(filesOnDisk.length === 3, '磁盘上确实有 3 个表情文件', filesOnDisk);

    // 库核对：sticker_items 里写了 sha256/size
    const db = new DatabaseSync(dbPath);
    const items = db.prepare(
      'SELECT url, sha256, size FROM sticker_items WHERE pack_id = ? ORDER BY sort_order'
    ).all(packId);
    db.close();
    ok(items.length === 3, '数据库 sticker_items 有 3 条');
    ok(items.every((i) => i.sha256 && i.sha256.length === 64),
      '每条 sticker_items 都写了 sha256', items.map((i) => i.sha256?.length));
    ok(items.every((i) => typeof i.size === 'number' && i.size > 0),
      '每条 sticker_items 都写了 size', items.map((i) => i.size));

    // [核心] /api/assets 看不到这些表情
    const all = await api('/api/assets', { token: A.token });
    ok((all.data?.assets || []).length === 0,
      '【独立库】/api/assets 全部列表里没有表情', (all.data?.assets || []).length);

    const asImage = await api('/api/assets?kind=image', { token: A.token });
    ok((asImage.data?.assets || []).length === 0,
      '【独立库】/api/assets?kind=image 也没有表情');

    const asSticker = await api('/api/assets?kind=sticker', { token: A.token });
    // listAssets 现在排除 kind=sticker，即使显式传 kind=sticker 也返回空
    ok((asSticker.data?.assets || []).length === 0,
      '【独立库】/api/assets?kind=sticker 返回空（listAssets 已排除）',
      (asSticker.data?.assets || []).length);

    // [核心] 配额统计包含表情
    const quota = await api('/api/assets/quota', { token: A.token });
    ok(quota.data?.used > 0,
      '【配额】表情占用被计入 used（不再漏算）', quota.data);

    // 上传一张真正的背景图，验证它**能**进 assets，且与表情区分
    const bgUp = await uploadPng('/api/assets/upload', A.token, png('bg'), 'bg.png', 'file', { kind: 'background' });
    ok(bgUp.status === 200, '普通资源池上传仍可用');
    const afterBg = await api('/api/assets', { token: A.token });
    ok((afterBg.data?.assets || []).length === 1,
      '【区分】/api/assets 里只有 1 张（背景），表情不在其中',
      (afterBg.data?.assets || []).length);
    ok((afterBg.data?.assets || [])[0]?.kind === 'background',
      '【区分】那 1 张的 kind 是 background');
  }

  // ============================================================
  section('2. 表情包商品：不可下载、不可预览');
  let productId = null;
  let productFileIds = [];
  {
    // 上传 2 张表情到商品目录（走 shop/upload，模拟卖家上架表情包）
    const up1 = await uploadPng('/api/shop/upload', A.token, png('p1'), 'p-st1.png', 'file');
    const up2 = await uploadPng('/api/shop/upload', A.token, png('p2'), 'p-st2.png', 'file');
    ok(up1.status === 200 && up2.status === 200, '商品文件上传成功', [up1.status, up2.status]);

    const create = await api('/api/shop/products', {
      method: 'POST', token: A.token,
      body: {
        title: `表情包商品${TS}`,
        description: '买了就能用，不能下载单张',
        price: 0,
        market: 'flea',
        category: 'sticker_pack',
        files: [
          { url: up1.data.url, name: 'p-st1.png', type: 'image/png', size: up1.data.size, isPreview: true },
          { url: up2.data.url, name: 'p-st2.png', type: 'image/png', size: up2.data.size, isPreview: true }
        ]
      }
    });
    ok(create.status === 200 && create.data?.ok, '表情包商品上架成功', create.data);
    productId = create.data?.id;
    ok(create.data?.category === 'sticker_pack', '分类为 sticker_pack');

    // 拉一下详情，拿到 fileId
    const detail = await api(`/api/shop/products/${productId}`, { token: A.token });
    const files = detail.data?.files || [];
    productFileIds = files.map((f) => f.id);
    ok(files.length === 2, '详情里能看到 2 个文件（只用于展示数量）');
    ok(files.every((f) => f.locked === true),
      '【数据保护】文件都标记为 locked', files.map((f) => f.locked));
    ok(files.every((f) => f.isPreview === false),
      '【数据保护】文件 isPreview 全部为 false（前端不渲染预览按钮）',
      files.map((f) => f.isPreview));

    // ---- 下载通道：任何角色都拒绝 ----
    const dlOwner = await api(`/api/shop/download/${productId}/${productFileIds[0]}`, { token: A.token });
    ok(dlOwner.status === 403, '【不可下载】卖家访问 → 403', dlOwner);

    const dlBuyer = await api(`/api/shop/download/${productId}/${productFileIds[0]}`, { token: B.token });
    ok(dlBuyer.status === 403, '【不可下载】未购买买家访问 → 403', dlBuyer);

    const dlOther = await api(`/api/shop/download/${productId}/${productFileIds[0]}`, { token: C.token });
    ok(dlOther.status === 403, '【不可下载】路人访问 → 403', dlOther);

    // ---- 预览通道：任何角色都拒绝 ----
    const pvOwner = await api(`/api/shop/preview/${productId}/${productFileIds[0]}`, { token: A.token });
    ok(pvOwner.status === 403, '【不可预览】卖家访问 → 403', pvOwner);

    const pvBuyer = await api(`/api/shop/preview/${productId}/${productFileIds[0]}`, { token: B.token });
    ok(pvBuyer.status === 403, '【不可预览】未购买买家访问 → 403', pvBuyer);

    const pvPlayback = await api(
      `/api/shop/preview/${productId}/${productFileIds[0]}?playback=1`,
      { token: B.token }
    );
    ok(pvPlayback.status === 403, '【不可预览】playback=1 也拒绝 → 403', pvPlayback);

    // ---- 未登录：连 401 之外的路径都碰不到 ----
    const pvAnon = await api(`/api/shop/preview/${productId}/${productFileIds[0]}`);
    ok(pvAnon.status === 401, '【不可预览】未登录访问 → 401', pvAnon.status);
  }

  // ============================================================
  section('3. 购买后整包入库到买家表情库');
  let grantedPackId = null;
  {
    // B 购买
    const buy = await api(`/api/shop/products/${productId}/buy`, {
      method: 'POST', token: B.token, body: {}
    });
    ok(buy.status === 200 && buy.data?.ok, 'B 购买成功', buy.data);
    grantedPackId = buy.data?.grantedPackId;
    ok(Number.isInteger(grantedPackId) && grantedPackId > 0,
      '【入库】返回 grantedPackId', grantedPackId);
    ok(buy.data?.grantedAssets === 2, '【入库】复制了 2 个表情', buy.data?.grantedAssets);

    // B 的表情包列表里能看到
    const bPacks = await api('/api/stickers/packs', { token: B.token });
    const got = (bPacks.data?.packs || []).find((p) => p.id === grantedPackId);
    ok(!!got, '【入库】B 的表情包列表含新包', got);
    ok(got?.source === 'purchase', '【入库】新包 source=purchase', got?.source);
    ok(got?.itemCount === 2, '【入库】新包有 2 个表情', got?.itemCount);

    // 读包详情
    const detail = await api(`/api/stickers/packs/${grantedPackId}`, { token: B.token });
    const items = detail.data?.items || [];
    ok(items.length === 2, '【入库】B 能读到包里的 2 个表情', items.length);
    ok(items.every((i) => i.url.startsWith(`/uploads/custom/${B.id}/sticker/`)),
      '【入库】表情落盘在 **买家自己** 的 sticker 目录', items.map((i) => i.url));
    ok(items.every((i) => i.sha256 && typeof i.size === 'number'),
      '【入库】买家表情项也写了 sha256/size');

    // 磁盘核对
    const bStickerDir = path.join(CUSTOM_DIR, String(B.id), 'sticker');
    const bFiles = fs.existsSync(bStickerDir) ? fs.readdirSync(bStickerDir) : [];
    ok(bFiles.length === 2, '【入库】买家磁盘上有 2 个表情文件', bFiles);

    // [核心] B 的 /api/assets 也看不到这些表情
    const bAssets = await api('/api/assets', { token: B.token });
    ok((bAssets.data?.assets || []).length === 0,
      '【独立库】买家 /api/assets 里没有表情', (bAssets.data?.assets || []).length);

    // B 的配额也算了
    const bQuota = await api('/api/assets/quota', { token: B.token });
    ok(bQuota.data?.used > 0, '【配额】买家配额含表情', bQuota.data);

    // 重复购买被拒
    const again = await api(`/api/shop/products/${productId}/buy`, {
      method: 'POST', token: B.token, body: {}
    });
    ok(again.status === 400, '重复购买被拒', again);

    // C 也能购买（数字素材授权）
    const cBuy = await api(`/api/shop/products/${productId}/buy`, {
      method: 'POST', token: C.token, body: {}
    });
    ok(cBuy.status === 200 && cBuy.data?.grantedPackId > 0, 'C 也能购买同一表情包');
    ok(cBuy.data.grantedPackId !== grantedPackId,
      'C 拿到的是**自己**的包（不是共享同一份）',
      [grantedPackId, cBuy.data.grantedPackId]);
  }

  // ============================================================
  section('4. lookupByUrl：右键菜单分流的服务端依据');
  {
    const aUrl = stickerUrls[0]; // A 表情包里的第 1 张
    ok(aUrl.startsWith(`/uploads/custom/${A.id}/sticker/`), '（前提）取到一张 A 的表情 url', aUrl);

    // A（owner）
    const aLookup = await api(`/api/stickers/lookup?url=${encodeURIComponent(aUrl)}`, { token: A.token });
    ok(aLookup.status === 200, 'A 查询成功');
    ok(aLookup.data?.info?.packId === packId, '【反查】返回正确的 packId', aLookup.data?.info?.packId);
    ok(aLookup.data?.info?.owned === true, '【反查】A owned=true');
    ok(aLookup.data?.info?.usable === true, '【反查】A usable=true');

    // C（路人）
    const cLookup = await api(`/api/stickers/lookup?url=${encodeURIComponent(aUrl)}`, { token: C.token });
    ok(cLookup.data?.info?.owned === false, '【反查】C（路人）owned=false');
    ok(cLookup.data?.info?.subscribed === false, '【反查】C subscribed=false');
    ok(cLookup.data?.info?.usable === false,
      '【反查】C usable=false → 前端右键只显示「购买」',
      cLookup.data?.info);

    // A 分享 → C 订阅 → usable=true
    const share = await api(`/api/stickers/packs/${packId}/share`, {
      method: 'POST', token: A.token, body: {}
    });
    ok(share.status === 200 && share.data?.shareCode, 'A 生成分享码', share.data);

    const sub = await api('/api/stickers/subscribe', {
      method: 'POST', token: C.token, body: { code: share.data.shareCode }
    });
    ok(sub.status === 200, 'C 订阅 A 的表情包');

    const cLookup2 = await api(`/api/stickers/lookup?url=${encodeURIComponent(aUrl)}`, { token: C.token });
    ok(cLookup2.data?.info?.subscribed === true, '【反查】C 订阅后 subscribed=true');
    ok(cLookup2.data?.info?.usable === true, '【反查】C 订阅后 usable=true');

    // 边界
    const anon = await api(`/api/stickers/lookup?url=${encodeURIComponent(aUrl)}`);
    ok(anon.status === 401, '【反查】未登录 → 401', anon.status);

    const notCustom = await api(
      `/api/stickers/lookup?url=${encodeURIComponent('/uploads/avatars/x.png')}`,
      { token: A.token }
    );
    ok(notCustom.status === 200 && notCustom.data?.info === null,
      '【反查】非 custom 目录的 url → null', notCustom.data);

    const notExist = await api(
      `/api/stickers/lookup?url=${encodeURIComponent('/uploads/custom/1/sticker/nope.png')}`,
      { token: A.token }
    );
    ok(notExist.status === 200 && notExist.data?.info === null,
      '【反查】不存在的 url → null', notExist.data);
  }

  // ============================================================
  section('5. 消息里的 stickerPackId 字段（右键菜单分流的前置）');
  {
    // A 在公共房发一条表情消息（带 stickerPackId）
    const send = await api('/api/messages', {
      method: 'POST', token: A.token,
      body: {
        roomType: 'public', roomId: 'public',
        text: '',
        fileUrl: stickerUrls[0],
        fileName: 's1.png',
        fileType: 'image',
        isSticker: true,
        stickerPackId: packId
      }
    });
    ok(send.status === 200 && send.data?.message?.id, 'A 发送带 stickerPackId 的表情消息', send.data);
    ok(send.data?.message?.stickerPackId === packId, '【字段】响应里带 stickerPackId');

    // 读历史，检查字段是否被正确下发
    const hist = await api('/api/messages?roomType=public&roomId=public&limit=10', { token: B.token });
    const target = (hist.data?.messages || []).find((m) => m.stickerPackId === packId);
    ok(!!target, '【字段】历史里能查到这条消息');
    ok(target?.isSticker === true, '【字段】isSticker=true');
    ok(target?.fileUrl === stickerUrls[0], '【字段】fileUrl 一致');

    // 非法 packId（不存在）被拒
    const bad = await api('/api/messages', {
      method: 'POST', token: A.token,
      body: {
        roomType: 'public', roomId: 'public',
        text: '',
        fileUrl: stickerUrls[0],
        fileName: 's1.png',
        fileType: 'image',
        isSticker: true,
        stickerPackId: 999999
      }
    });
    ok(bad.status === 400, '【字段】不存在的 stickerPackId 被拒', bad.data);

    // 不带 stickerPackId 也允许（历史遗留兼容）
    const noId = await api('/api/messages', {
      method: 'POST', token: A.token,
      body: {
        roomType: 'public', roomId: 'public',
        text: '',
        fileUrl: stickerUrls[1],
        fileName: 's2.png',
        fileType: 'image',
        isSticker: true
      }
    });
    ok(noId.status === 200, '【字段】不带 stickerPackId 的表情消息也允许（历史兼容）');
  }

  // ============================================================
  section('6. 收尾');
  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(A.id);
    db.close();
    ok(true, '已还原 A 的角色');
  }

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n表情包专项回归异常：', err);
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