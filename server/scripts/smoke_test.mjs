// scripts/smoke_test.mjs
//
// 端到端冒烟测试：偏好 / 资源池 / 表情包 / 商城外观素材 / API 密钥通道。
//
// 用法：先启动服务（node index.js），再执行
//   node scripts/smoke_test.mjs            # 跑完自动删掉本套测试账号
//   node scripts/smoke_test.mjs --keep     # 保留测试账号，便于事后排查
//
// 注意：API 密钥的 IP 绑定规则是「同一 IP 只能绑定一个用户」，
//       本脚本全部请求来自 127.0.0.1，因此会显式验证这一约束。
//
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTestAccounts, snapshotUploads, cleanupRunUploads } from './lib/cleanup_accounts.mjs';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'chat.db');

const TS = Date.now().toString().slice(-7);

let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

function section(t) {
  console.log(`\n\x1b[36m${t}\x1b[0m`);
}

async function api(pathname, { method = 'GET', token, key, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-API-Key'] = key;

  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, data, headers: res.headers, raw: text.slice(0, 200) };
}

// 1x1 PNG（合法图片头，尾部追加字节用于制造不同 sha256）
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

function png(tag = '') {
  // 混入本次运行的时间戳：保证每次运行的素材内容不同，
  // 否则跨次运行会互相触发 sha256 素材抄袭检测
  return Buffer.concat([PNG_1x1, Buffer.from(`#${TS}:${tag}`)]);
}

function pngForm(field, files, extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  const list = Array.isArray(files) ? files : [files];
  for (const f of list) {
    const name = typeof f === 'string' ? f : f.name;
    const buf = typeof f === 'string' ? png(f) : f.buf;
    fd.append(field, new Blob([buf], { type: 'image/png' }), name);
  }
  return fd;
}

const main = async () => {
  // 收尾要用的「跑之前 uploads/ 长什么样」快照（只清本次新增的无主文件）
  const uploadsBefore = snapshotUploads();
  const users = {};

  // ============================================================
  section('0. 准备账号');
  for (const who of ['a', 'b', 'c']) {
    const username = `sm_${TS}_${who}`;
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password: 'pass1234', nickname: `冒烟${who.toUpperCase()}` }
    });
    users[who] = { username, token: r.data?.token, id: r.data?.user?.id };
    ok(r.status === 200 && !!r.data?.token, `注册 ${username}`);
  }

  // 把 A 提升为 developer（直接改库，便于验证管理接口）
  {
    const db = new DatabaseSync(DB_PATH);
    db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(users.a.id);
    // 让脚本可重复执行：只清掉**本套测试账号**上一轮遗留的 IP 绑定。
    // [SEC] 这里绝不能用 `DELETE FROM apikey_ip_claims`（全表）——
    //       那会连带删掉真实用户在管理端维护的 IP 绑定。
    const wiped = db.prepare(
      `DELETE FROM apikey_ip_claims
        WHERE user_id IN (SELECT id FROM users WHERE substr(username, 1, 3) = 'sm_')`
    ).run();
    db.close();
    const me = await api('/api/auth/me', { token: users.a.token });
    ok(me.data?.user?.role === 'developer', 'A 已提升为 developer');
    if (wiped.changes) console.log(`  （已清理上一轮 sm_ 测试账号遗留的 ${wiped.changes} 条 IP 绑定）`);
  }

  // ============================================================
  section('1. 用户偏好（全局背景 / 单房间背景 / 气泡 JSON / 字号）');
  {
    const empty = await api('/api/preferences', { token: users.a.token });
    ok(empty.status === 200, 'GET /api/preferences 200');
    ok(empty.data?.global?.background === null, '未设置时 background 为 null（前端保持现状）');
    ok(empty.data?.global?.fontSize === null, '未设置时 fontSize 为 null');
    ok(empty.data?.global?.bubble === null, '未设置时 bubble 为 null');

    const put = await api('/api/preferences', {
      method: 'PUT',
      token: users.a.token,
      body: {
        global: {
          background: '#112233',
          fontSize: 17,
          bubble: { self: { bg: '#000000', color: '#ffffff', radius: 8 }, other: { bg: '#f0f0f0' } }
        },
        room: { roomKey: 'public', background: '#445566' }
      }
    });
    ok(put.status === 200, 'PUT /api/preferences 200');
    ok(put.data?.global?.background === '#112233', '全局背景已保存');
    ok(put.data?.global?.fontSize === 17, '字号已保存');
    ok(put.data?.global?.bubble?.self?.radius === 8, '气泡 JSON 已保存');
    ok(put.data?.rooms?.public?.background === '#445566', '单房间背景已保存');

    const again = await api('/api/preferences', { token: users.a.token });
    ok(again.data?.global?.fontSize === 17, '重新 GET 仍然一致（跨设备同步基础）');

    const bad = await api('/api/preferences', {
      method: 'PUT', token: users.a.token,
      body: { global: { background: 'javascript:alert(1)' } }
    });
    ok(bad.status === 400, '非法背景被拒绝');

    const badFont = await api('/api/preferences', {
      method: 'PUT', token: users.a.token, body: { global: { fontSize: 999 } }
    });
    ok(badFont.status === 400, '越界字号被拒绝');

    const badRoom = await api('/api/preferences', {
      method: 'PUT', token: users.a.token,
      body: { room: { roomKey: `p_${users.b.id}_${users.c.id}`, background: '#ffffff' } }
    });
    ok(badRoom.status === 400, '无权设置他人私聊房间背景');

    const del = await api('/api/preferences/room/public', {
      method: 'DELETE', token: users.a.token
    });
    ok(del.status === 200 && !del.data?.rooms?.public, '可清除单房间背景');

    const bEmpty = await api('/api/preferences', { token: users.b.token });
    ok(bEmpty.data?.global?.background === null, 'B 的偏好不受 A 影响');
  }

  // ============================================================
  section('2. 统一资源池（sha256 去重 / 配额 / uploads/custom/{userId}/）');
  let assetA1 = null;
  {
    const up = await api('/api/assets/upload', {
      method: 'POST', token: users.a.token,
      form: pngForm('file', 'bg-1.png', { kind: 'background' })
    });
    ok(up.status === 200, 'POST /api/assets/upload 200');
    assetA1 = up.data?.asset;
    ok(!!assetA1?.url?.startsWith(`/uploads/custom/${users.a.id}/`), '文件落在 uploads/custom/{userId}/', assetA1?.url);
    ok(assetA1?.sha256?.length === 64, '返回 sha256');
    ok(assetA1?.kind === 'background', 'kind 生效');

    const dup = await api('/api/assets/upload', {
      method: 'POST', token: users.a.token,
      form: pngForm('file', { name: 'bg-1-copy.png', buf: png('bg-1.png') }, { kind: 'background' })
    });
    ok(dup.data?.deduped === 1 && dup.data?.created === 0, '相同 sha256 被去重');
    ok(dup.data?.asset?.url === assetA1.url, '去重返回同一份文件');

    const up2 = await api('/api/assets/upload', {
      method: 'POST', token: users.a.token,
      form: pngForm('file', 'bg-2.png', { kind: 'background' })
    });
    ok(up2.data?.created === 1, '不同内容正常入库');

    const list = await api('/api/assets?kind=background', { token: users.a.token });
    ok(list.data?.assets?.length === 2, '按 kind 列出资源', list.data?.assets?.length);
    ok(list.data?.usage?.quota === 0, '配额不限总量（quota=0，单次/单文件上限仍在）', list.data?.usage);
    ok(list.data?.usage?.used > 0, '已用量统计');

    const bList = await api('/api/assets', { token: users.b.token });
    ok(bList.data?.assets?.length === 0, '资源池按用户隔离');

    const badType = await api('/api/assets/upload', {
      method: 'POST', token: users.a.token,
      form: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('<svg/>')], { type: 'image/svg+xml' }), 'x.svg');
        return fd;
      })()
    });
    ok(badType.status === 400, 'SVG 被拒绝');

    const batch = await api('/api/assets/upload', {
      method: 'POST', token: users.a.token,
      form: pngForm('files', [{ name: 'm1.png', buf: png('m1') }, { name: 'm2.png', buf: png('m2') }], { kind: 'image' })
    });
    ok(batch.data?.created === 2, '批量上传 2 张');
  }

  // ============================================================
  section('3. 表情包（创建 / 批量上传 / 排序 / 分享码订阅 / 原包实时可见）');
  let packId = null;
  let shareCode = null;
  let firstItemUrl = null;
  {
    const create = await api('/api/stickers/packs', {
      method: 'POST', token: users.a.token, body: { name: `冒烟表情包${TS}` }
    });
    ok(create.status === 201, '创建表情包');
    packId = create.data?.pack?.id;

    const add = await api(`/api/stickers/packs/${packId}/items`, {
      method: 'POST', token: users.a.token,
      form: pngForm('files', [
        { name: 'st1.png', buf: png('st1') },
        { name: 'st2.png', buf: png('st2') }
      ])
    });
    ok(add.status === 200 && add.data?.created === 2, '批量上传 2 个表情');
    firstItemUrl = add.data?.items?.[0]?.url;

    const detail = await api(`/api/stickers/packs/${packId}`, { token: users.a.token });
    ok(detail.data?.items?.length === 2, '表情包详情含 2 项');

    const order = detail.data.items.map((i) => i.id).reverse();
    const re = await api(`/api/stickers/packs/${packId}/items/order`, {
      method: 'PUT', token: users.a.token, body: { order }
    });
    ok(re.status === 200 && re.data?.items?.[0]?.id === order[0], '排序生效');

    const share = await api(`/api/stickers/packs/${packId}/share`, {
      method: 'POST', token: users.a.token, body: {}
    });
    ok(share.status === 200 && !!share.data?.shareCode, '生成分享码');
    shareCode = share.data.shareCode;

    // B 订阅
    const sub = await api('/api/stickers/subscribe', {
      method: 'POST', token: users.b.token, body: { code: shareCode }
    });
    ok(sub.status === 200 && sub.data?.pack?.id === packId, 'B 凭码订阅');

    const bList = await api('/api/stickers/packs', { token: users.b.token });
    ok(bList.data?.packs?.some((p) => p.id === packId && !p.isOwner), 'B 的表情包列表包含订阅包');

    const bDetail = await api(`/api/stickers/packs/${packId}`, { token: users.b.token });
    ok(bDetail.data?.items?.length === 2, 'B 能看到原包内容');
    ok(bDetail.data?.items?.[0]?.url === re.data?.items?.[0]?.url, '订阅读到的是原包文件（未复制）');

    const bAssets = await api('/api/assets', { token: users.b.token });
    const leaked = (bAssets.data?.assets || []).filter((a) => a.kind === 'sticker');
    ok(leaked.length === 0, '订阅不复制文件（B 资源池无新增表情文件）', leaked.length);

    // 原包更新 → 订阅者再取即可见（同一份数据，无同步副本）
    const add2 = await api(`/api/stickers/packs/${packId}/items`, {
      method: 'POST', token: users.a.token,
      form: pngForm('files', [{ name: 'st3.png', buf: png('st3') }])
    });
    ok(add2.status === 200, '原包新增 1 个表情');
    const bDetail2 = await api(`/api/stickers/packs/${packId}`, { token: users.b.token });
    ok(bDetail2.data?.items?.length === 3, '订阅者立即看到原包更新');

    const cSub = await api('/api/stickers/subscribe', {
      method: 'POST', token: users.c.token, body: { code: shareCode }
    });
    ok(cSub.status === 200, 'C 也能订阅同一个公开包');

    const dupSub = await api('/api/stickers/subscribe', {
      method: 'POST', token: users.c.token, body: { code: shareCode }
    });
    ok(dupSub.status === 400, '重复订阅被拒');

    const badCode = await api('/api/stickers/subscribe', {
      method: 'POST', token: users.c.token, body: { code: 'NOPE000000' }
    });
    ok(badCode.status === 400, '无效分享码被拒');

    const foreign = await api(`/api/stickers/packs/${packId}/items`, {
      method: 'POST', token: users.c.token,
      form: pngForm('files', [{ name: 'x.png', buf: png('x') }])
    });
    ok(foreign.status === 400, '非作者不能往包里加表情');
  }

  // ============================================================
  section('4. 商城整合（外观素材 / 免费商品 / 抄袭检测 / 归入买家资源库）');
  let bgProductId = null;
  {
    const upload1 = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token,
      form: pngForm('file', 'theme-bg.png')
    });
    ok(upload1.status === 200, '商城素材上传');

    const create = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `冒烟背景${TS}`,
        description: '免费的聊天背景素材',
        price: 0,
        market: 'flea',
        category: 'background',
        files: [{ url: upload1.data.url, name: 'theme-bg.png', type: 'image/png', size: 120 }]
      }
    });
    ok(create.status === 200 && create.data?.ok, '免费外观商品上架成功');
    ok(create.data?.price === 0, '价格下限 0 生效（免费商品）');
    ok(create.data?.category === 'background', 'category 生效');
    bgProductId = create.data.id;

    // [CHANGED] 同文件换标题**由另一用户**上架 → sha256 素材比对命中。
    //   防抄袭已改为不误伤卖家自己（重发/换标题重上架是合法操作），
    //   所以这条检测链路必须用不同卖家来验证。
    const upload1b = await api('/api/shop/upload', {
      method: 'POST', token: users.b.token,
      form: pngForm('file', { name: 'theme-bg-copy.png', buf: png('theme-bg.png') })
    });
    const dup = await api('/api/shop/products', {
      method: 'POST', token: users.b.token,
      body: {
        title: `冒烟背景副本${TS}`,
        description: '换了个标题',
        price: 0,
        market: 'flea',
        category: 'background',
        files: [{ url: upload1b.data.url, name: 'theme-bg-copy.png', type: 'image/png', size: 120 }]
      }
    });
    ok(dup.data?.status === 'pirated', '免费商品同样被 sha256 抄袭检测拦下', dup.data);

    // 外观素材不能只放 JSON
    const onlyJson = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `只有JSON${TS}`, description: '-', price: 0, market: 'flea', category: 'bubble',
        files: [{ url: upload1.data.url, name: 'theme.json', type: 'application/json', size: 10 }]
      }
    });
    ok(onlyJson.status === 400, '外观素材必须有图片文件');

    // 跳蚤市场价格越界
    const neg = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `负数${TS}`, description: '-', price: -5, market: 'flea', category: 'background',
        files: [{ url: upload1.data.url, name: 'a.png', type: 'image/png', size: 10 }]
      }
    });
    ok(neg.status === 400, '负数价格被拒绝');

    // B 购买免费背景
    const buy = await api(`/api/shop/products/${bgProductId}/buy`, {
      method: 'POST', token: users.b.token, body: {}
    });
    ok(buy.status === 200 && buy.data?.ok, '免费商品可以购买', buy.data);
    ok(buy.data?.grantedAssets >= 1, '购买后归入买家资源库', buy.data);

    const bAssets = await api('/api/assets?kind=background', { token: users.b.token });
    ok(bAssets.data?.assets?.length >= 1, '买家资源库出现该背景');

    const buyAgain = await api(`/api/shop/products/${bgProductId}/buy`, {
      method: 'POST', token: users.b.token, body: {}
    });
    ok(buyAgain.status === 400, '重复购买被拒');

    const buyOwn = await api(`/api/shop/products/${bgProductId}/buy`, {
      method: 'POST', token: users.a.token, body: {}
    });
    ok(buyOwn.status === 400, '不能买自己的商品');

    const stillOnSale = await api(`/api/shop/products/${bgProductId}`, { token: users.c.token });
    ok(stillOnSale.data?.product?.status === 'on_sale', '外观素材可被多人购买');

    const cBuy = await api(`/api/shop/products/${bgProductId}/buy`, {
      method: 'POST', token: users.c.token, body: {}
    });
    ok(cBuy.status === 200, 'C 也能购买同一外观素材');

    const market = await api('/api/shop/market/flea?category=background', { token: users.b.token });
    ok((market.data?.products || []).some((p) => p.id === bgProductId), '按 category 过滤市场列表');

    // 标准市场：强制 0 价 + 待审核 + 开发者定价审核（免费同样走流程）
    const stdUpload = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'std-bg.png')
    });
    const std = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `标准免费背景${TS}`, description: '待审核', price: 0, market: 'standard',
        category: 'background',
        files: [{ url: stdUpload.data.url, name: 'std-bg.png', type: 'image/png', size: 120 }]
      }
    });
    ok(std.data?.status === 'pending_review', '标准市场进待审核');

    const pending = await api('/api/admin/shop/pending-review', { token: users.a.token });
    ok((pending.data?.products || []).some((p) => p.id === std.data.id), '待审核列表包含外观素材');
    ok(pending.data?.products?.find((p) => p.id === std.data.id)?.category === 'background', '待审核列表带 category');

    const review = await api(`/api/admin/shop/review/${std.data.id}`, {
      method: 'POST', token: users.a.token, body: { price: 0, note: '免费' }
    });
    ok(review.status === 200, '免费商品同样走定价审核');

    // 气泡主题：json + 图片
    const bubbleJson = Buffer.from(JSON.stringify({ self: { bg: '#123456', color: '#ffffff', radius: 10 } }));
    const bubbleImg = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'bubble-tex.png')
    });
    const bubbleJsonUp = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token,
      form: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([bubbleJson], { type: 'application/json' }), 'theme.json');
        return fd;
      })()
    });
    const bubble = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `冒烟气泡${TS}`, description: '气泡主题', price: 0, market: 'flea', category: 'bubble',
        files: [
          { url: bubbleImg.data.url, name: 'bubble-tex.png', type: 'image/png', size: 130 },
          { url: bubbleJsonUp.data.url, name: 'theme.json', type: 'application/json', size: bubbleJson.length }
        ]
      }
    });
    ok(bubble.data?.ok, '气泡主题上架');
    const bBuyBubble = await api(`/api/shop/products/${bubble.data.id}/buy`, {
      method: 'POST', token: users.b.token, body: {}
    });
    ok(bBuyBubble.status === 200, 'B 购买气泡主题');
    const bBubbleAssets = await api('/api/assets?kind=bubble', { token: users.b.token });
    const bubbleAsset = bBubbleAssets.data?.assets?.[0];
    ok(!!bubbleAsset, '气泡主题进入买家资源库');
    ok(bubbleAsset?.meta?.self?.radius === 10, '气泡主题配置随资源一起入库', bubbleAsset?.meta);

    // 表情包商品
    const s1 = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'p-st1.png')
    });
    const s2 = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'p-st2.png')
    });
    const packProduct = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `冒烟表情包商品${TS}`, description: '一整套表情', price: 0, market: 'flea',
        category: 'sticker_pack',
        files: [
          { url: s1.data.url, name: 'p-st1.png', type: 'image/png', size: 110 },
          { url: s2.data.url, name: 'p-st2.png', type: 'image/png', size: 111 }
        ]
      }
    });
    ok(packProduct.data?.ok, '表情包商品上架');
    const cBuyPack = await api(`/api/shop/products/${packProduct.data.id}/buy`, {
      method: 'POST', token: users.c.token, body: {}
    });
    ok(cBuyPack.data?.grantedPackId > 0, '购买表情包商品后买家获得自己的表情包');
    const cPacks = await api('/api/stickers/packs', { token: users.c.token });
    const bought = (cPacks.data?.packs || []).find((p) => p.id === cBuyPack.data.grantedPackId);
    ok(!!bought && bought.itemCount === 2, '新表情包含 2 个表情', bought);

    const mine = await api('/api/shop/mine', { token: users.a.token });
    ok((mine.data?.products || []).every((p) => 'category' in p), '我发布的列表带 category');
  }

  // ============================================================
  section('4.5 附件分类（视频/音频内联播放）与商品「试看」');
  {
    // ---- /api/file 的分类：前端据此决定内联播放还是文件卡片 ----
    const kindCases = [
      ['v.mp4', 'video/mp4', 'video'],
      ['a.mp3', 'audio/mpeg', 'audio'],
      ['i.png', 'image/png', 'image'],
      ['d.txt', 'text/plain', 'file']
    ];
    for (const [name, mime, want] of kindCases) {
      const fd = new FormData();
      fd.append('file', new Blob([png(name)], { type: mime }), name);
      const r = await api('/api/file', { method: 'POST', token: users.a.token, form: fd });
      ok(r.data?.kind === want, `/api/file ${name}（${mime}）→ kind=${want}`, r.data);
    }

    // ---- 商品「试看」：勾了 isPreview 的文件，未购买也能预览 ----
    const pvUp = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'pv-preview.png')
    });
    const pvUp2 = await api('/api/shop/upload', {
      method: 'POST', token: users.a.token, form: pngForm('file', 'pv-secret.png')
    });
    const pvProduct = await api('/api/shop/products', {
      method: 'POST', token: users.a.token,
      body: {
        title: `冒烟试看${TS}`, description: '一份可试看、一份需购买', price: 0, market: 'flea',
        files: [
          { url: pvUp.data.url, name: '预览图.png', type: 'image/png', size: 90, isPreview: true },
          { url: pvUp2.data.url, name: '完整素材.png', type: 'image/png', size: 91, isPreview: false }
        ]
      }
    });
    ok(pvProduct.data?.ok, '试看商品上架');

    const detail = await api(`/api/shop/products/${pvProduct.data.id}`, { token: users.c.token });
    const pvFiles = detail.data?.files || [];
    const previewFile = pvFiles.find((f) => f.name === '预览图.png');
    const secretFile = pvFiles.find((f) => f.name === '完整素材.png');
    ok(!!previewFile?.isPreview, '详情页下发 isPreview 标记', previewFile);
    ok(previewFile?.isPreview === true && secretFile?.isPreview === false, '两份文件的试看标记各自独立');

    // C 没买过，也能试看
    const pvOk = await api(`/api/shop/preview/${pvProduct.data.id}/${previewFile.id}`, { token: users.c.token });
    ok(pvOk.status === 200, '未购买可预览「已勾选试看」的文件', pvOk.status);
    const pvDenied = await api(`/api/shop/preview/${pvProduct.data.id}/${secretFile.id}`, { token: users.c.token });
    ok(pvDenied.status === 404, '未勾选试看的文件不能预览（404）', pvDenied.status);
    const pvNoAuth = await api(`/api/shop/preview/${pvProduct.data.id}/${previewFile.id}`);
    ok(pvNoAuth.status === 401, '未登录不能预览', pvNoAuth.status);

    // ---- 试看图不允许被「顺手留档」：响应头 + 限流 ----
    // 客户端那边拦右键只是顺手挡一下（ProtectedImage），能约束脚本的只有服务端这两条。
    ok(pvOk.headers?.get('cache-control') === 'no-store',
      '试看响应禁止缓存（不在浏览器缓存里留可离线打开的副本）', pvOk.headers?.get('cache-control'));
    ok(pvOk.headers?.get('x-content-type-options') === 'nosniff',
      '试看响应带 nosniff（不按别的类型解析）', pvOk.headers?.get('x-content-type-options'));

    // 预览限流：登录即可拉，所以必须挡「用脚本成批扒」。额度由 config 决定，
    // 这里循环到 429 为止（上限 200 次，配置改成更大时这条会失败并提醒改测试）。
    let pvLimitHit = null;
    let pvTries = 0;
    for (; pvTries < 200 && !pvLimitHit; pvTries++) {
      const r = await api(`/api/shop/preview/${pvProduct.data.id}/${previewFile.id}`, { token: users.c.token });
      if (r.status === 429) pvLimitHit = r;
    }
    ok(!!pvLimitHit, `试看限流生效（第 ${pvTries} 次请求被拒）`, pvLimitHit?.data);
    ok(/预览过于频繁/.test(pvLimitHit?.data?.error || ''), '超限文案说清了是「预览」过频', pvLimitHit?.data?.error);
  }

  // ============================================================
  section('5. API 密钥体系（第二认证通道 / IP 绑定 / 覆盖现有接口）');
  let keyA = null;
  {
    const noAuth = await api('/api/v1/state');
    ok(noAuth.status === 401, '未带密钥访问 /api/v1 被拒');

    const jwtOnV1 = await api('/api/v1/state', { token: users.a.token });
    ok(jwtOnV1.status === 401, '/api/v1 不接受 JWT（通道隔离）');

    const applyA = await api('/api/keys', { method: 'POST', token: users.a.token, body: { name: '脚本用' } });
    ok(applyA.status === 201, 'A 申请密钥');
    keyA = applyA.data?.key;
    ok(typeof keyA === 'string' && keyA.startsWith('rk_'), '返回一次性明文');
    ok(applyA.data?.prefix?.length === 12, '返回 12 位前缀');
    ok(!JSON.stringify(applyA.data).includes('key_hash'), '响应不含哈希');

    const listA = await api('/api/keys', { token: users.a.token });
    ok(listA.data?.keys?.length >= 1, '列表可用');
    ok(!JSON.stringify(listA.data).includes(keyA), '列表不回显明文');
    ok(typeof listA.data?.keys?.[0]?.prefix === 'string', '列表显示前缀');
    ok('lastUsedAt' in listA.data.keys[0], '列表显示最近使用时间');

    // 覆盖现有受 JWT 保护的接口
    const prefsByKey = await api('/api/preferences', { key: keyA });
    ok(prefsByKey.status === 200, '密钥可访问既有 JWT 接口（偏好）');

    const pointsByKey = await api('/api/points/me', { key: keyA });
    ok(pointsByKey.status === 200, '密钥可访问积分接口');

    const shopByKey = await api('/api/shop/market/flea', { key: keyA });
    ok(shopByKey.status === 200, '密钥可访问商城接口');

    const adminByKey = await api('/api/admin/users', { key: keyA });
    ok(adminByKey.status === 200, '密钥可访问管理接口');

    const rolesByKey = await api('/api/roles/my-requests', { key: keyA });
    ok(rolesByKey.status === 200, '密钥可访问角色接口');

    const v1ByKey = await api('/api/v1/state', { key: keyA });
    ok(v1ByKey.status === 200 && v1ByKey.data?.authType === 'apikey', '/api/v1 密钥通道可用');

    // ---------- 密钥级 IP 绑定（回归：boundIp 曾只记录不校验） ----------
    {
      const db = new DatabaseSync(DB_PATH);
      const row = db.prepare('SELECT id, bound_ip AS boundIp FROM api_keys WHERE prefix = ?')
        .get(applyA.data?.prefix);
      ok(row?.boundIp === '127.0.0.1', '创建密钥时记录了绑定 IP', row);
      // 把绑定值改成一个「本机不可能拥有的来源 IP」，模拟密钥从别处被使用。
      // 只动本套测试刚创建的这一把密钥，稍后还原（收尾还会整把撤销）。
      db.prepare("UPDATE api_keys SET bound_ip = '10.9.9.9' WHERE id = ?").run(row?.id);
      db.close();

      const mismatch = await api('/api/v1/state', { key: keyA });
      ok(mismatch.status === 403, '来源 IP 与 boundIp 不一致 → 403 拒绝', mismatch.data);

      const db2 = new DatabaseSync(DB_PATH);
      db2.prepare('UPDATE api_keys SET bound_ip = ? WHERE id = ?').run(row?.boundIp, row?.id);
      db2.close();

      const restored = await api('/api/v1/state', { key: keyA });
      ok(restored.status === 200, '绑定 IP 还原后密钥恢复可用');
    }

    // REST 镜像：消息 / 好友 / 群聊
    const send = await api('/api/v1/messages', {
      method: 'POST', key: keyA,
      body: { roomType: 'public', roomId: 'public', text: `脚本消息${TS}` }
    });
    ok(send.status === 200 && send.data?.message?.id, 'curl 可发消息（REST 镜像）');

    const history = await api('/api/v1/messages?roomType=public&roomId=public&limit=5', { key: keyA });
    ok((history.data?.messages || []).some((m) => m.text === `脚本消息${TS}`), '消息可读回');

    const stickerSend = await api('/api/v1/messages', {
      method: 'POST', key: keyA,
      body: {
        roomType: 'public', roomId: 'public', text: '',
        fileUrl: firstItemUrl, fileName: 'st.png', fileType: 'image', isSticker: true
      }
    });
    ok(stickerSend.status === 200 && stickerSend.data?.message?.isSticker === true, '可发送 isSticker 消息');

    const badSticker = await api('/api/v1/messages', {
      method: 'POST', key: keyA,
      body: { roomType: 'public', roomId: 'public', isSticker: true, fileUrl: 'https://evil/x.png' }
    });
    ok(badSticker.status === 400, '非法表情消息被拒');

    const friendReq = await api('/api/friends/requests', {
      method: 'POST', token: users.b.token, body: { username: users.c.username }
    });
    ok(friendReq.status === 200, 'B 用 JWT 发好友申请');

    const reqs = await api('/api/friends/requests', { key: keyA });
    ok(reqs.status === 200 && 'received' in reqs.data, '好友申请列表可用（密钥通道）');

    const cReqs = await api('/api/v1/friends/requests', { token: users.c.token });
    ok(cReqs.status === 401, '/api/v1 不收 JWT（需走密钥）');

    const cReqs2 = await api('/api/friends/requests', { token: users.c.token });
    const reqId = cReqs2.data?.received?.[0]?.id;
    const accept = await api(`/api/friends/requests/${reqId}/accept`, {
      method: 'POST', token: users.c.token, body: {}
    });
    ok(accept.status === 200, '接受好友申请', { reqId, status: accept.status, raw: accept.raw });

    const cFriends = await api('/api/friends', { token: users.c.token });
    ok((cFriends.data?.friends || []).some((f) => f.id === users.b.id), '好友关系建立', cFriends.data);

    const group = await api('/api/groups', {
      method: 'POST', token: users.c.token, body: { name: `冒烟群${TS}`, memberIds: [users.b.id] }
    });
    ok(group.status === 200 && group.data?.groupId, 'REST 创建群聊', group.data);
    const gid = group.data?.groupId;

    const gInfo = await api(`/api/groups/${gid}`, { token: users.b.token });
    ok(gInfo.data?.group?.members?.length === 2, '群成员 2 人', gInfo.data);

    const gMsg = await api('/api/v1/messages', {
      method: 'POST', key: keyA,
      body: { roomType: 'group', roomId: `g_${gid}`, text: '脚本群消息' }
    });
    ok(gMsg.status === 403, '非群成员发群消息被拒');

    const gMsg2 = await api('/api/v1/messages', {
      method: 'POST', key: keyA,
      body: { roomType: 'group', roomId: `g_${gid}`, text: '密钥也可发群消息（A 需在群内）' }
    });
    ok(gMsg2.status === 403, '密钥通道同样受群成员校验');

    const gMsg3 = await api('/api/messages', {
      method: 'POST', token: users.b.token,
      body: { roomType: 'group', roomId: `g_${gid}`, text: '群内消息' }
    });
    ok(gMsg3.status === 200, '群成员可发群消息');

    const online = await api('/api/v1/presence/online', { key: keyA });
    ok(online.status === 200 && Array.isArray(online.data?.online), '在线状态可查');
    // [SEC] 在线列表不下发 username（那是登录标识 = 用户枚举的原料）。
    //   本脚本是纯 HTTP，在线列表为空，故这里只锁字段契约。
    ok(
      (online.data?.online || []).every((u) => !('username' in u) && 'nickname' in u),
      '在线列表只给 id/nickname/avatar，不含 username',
      online.data?.online?.[0]
    );

    // ---------- IP 绑定 ----------
    const applyB = await api('/api/keys', { method: 'POST', token: users.b.token, body: {} });
    ok(applyB.status === 403, '同一 IP 第二个用户申请密钥被拒', applyB.data);

    // ---------- 撤销 ----------
    const keyId = listA.data.keys[0].id;
    const rev = await api(`/api/keys/${keyId}/revoke`, { method: 'POST', token: users.a.token });
    ok(rev.status === 200, '撤销密钥');
    const afterRevoke = await api('/api/v1/state', { key: keyA });
    ok(afterRevoke.status === 401, '撤销后密钥立即失效');

    const claims1 = await api('/api/admin/apikeys/ip-claims', { token: users.a.token });
    ok((claims1.data?.claims || []).length >= 1, '管理员可查看 IP 绑定');
    ok(claims1.data?.claims?.[0]?.ip === '127.0.0.1', 'IP 已绑定（撤销不释放）', claims1.data?.claims?.[0]);

    const applyB2 = await api('/api/keys', { method: 'POST', token: users.b.token, body: {} });
    ok(applyB2.status === 403, '撤销密钥不释放 IP 绑定');

    // 非管理员不能释放
    const denyRelease = await api('/api/admin/apikeys/ip-claims/release', {
      method: 'POST', token: users.b.token, body: { ip: '127.0.0.1' }
    });
    ok(denyRelease.status === 403, '普通用户不能释放 IP 绑定');

    const release = await api('/api/admin/apikeys/ip-claims/release', {
      method: 'POST', token: users.a.token, body: { ip: '127.0.0.1', note: '冒烟测试' }
    });
    ok(release.status === 200, '管理员手动释放 IP 绑定');

    const applyB3 = await api('/api/keys', { method: 'POST', token: users.b.token, body: {} });
    ok(applyB3.status === 201, '释放后其他用户可重新绑定该 IP');
    const keyB = applyB3.data.key;

    const useB = await api('/api/v1/state', { key: keyB });
    ok(useB.status === 200 && useB.data?.user?.id === users.b.id, 'B 的密钥可用');

    // ---------- 封禁即时失效 ----------
    const ban = await api(`/api/admin/users/${users.b.id}/status`, {
      method: 'POST', token: users.a.token, body: { status: 'banned', reason: '冒烟测试' }
    });
    ok(ban.status === 200, '封禁 B');
    const banned = await api('/api/v1/state', { key: keyB });
    ok(banned.status === 401, '被封禁账号的密钥即时失效', banned.data);

    await api(`/api/admin/users/${users.b.id}/status`, {
      method: 'POST', token: users.a.token, body: { status: 'active' }
    });
    const stillRevoked = await api('/api/v1/state', { key: keyB });
    ok(stillRevoked.status === 401, '解封后密钥仍需重新申请（封禁时已撤销）');
  }

  // ============================================================
  section('6. 清理（只回收本套测试账号，不动真实用户的数据）');
  {
    // [SEC] 原先这里遍历**全部** IP 绑定逐个 release，会把真实用户在管理端
    //       维护的绑定一并释放掉。现在只释放「归属本套 sm_ 测试账号」的那些。
    const claims = await api('/api/admin/apikeys/ip-claims?all=1', { token: users.a.token });
    const mine = new Set(Object.values(users).map((u) => u.id));
    const targets = (claims.data?.claims || []).filter(
      (c) => !c.releasedAt && mine.has(c.userId)
    );
    for (const c of targets) {
      await api('/api/admin/apikeys/ip-claims/release', {
        method: 'POST', token: users.a.token, body: { ip: c.ip, note: '冒烟测试收尾' }
      });
    }
    const left = await api('/api/admin/apikeys/ip-claims', { token: users.a.token });
    const stillMine = (left.data?.claims || []).filter((c) => mine.has(c.userId));
    ok(stillMine.length === 0, `收尾：本套测试账号的 IP 绑定已全部释放（释放 ${targets.length} 条）`);

    // 还原被提升的角色（原先提到 developer 后从不还原，会留下特权残留）
    {
      const db = new DatabaseSync(DB_PATH);
      const n = db.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role != 'user'")
        .run(users.a.id).changes;
      db.close();
      ok(true, `收尾：已还原 A 的角色${n ? '' : '（本来就是 user）'}`);
    }
  }

  // [收尾] 把本套 sm_ 测试账号连同名下数据与上传文件一起删掉。
  // 跑在真实库上，不收尾就会一轮一轮沉淀（ERRORLOG TEST-1 / DEVLOG §1.74）。
  // 想保留现场：node scripts/smoke_test.mjs --keep
  cleanupTestAccounts(Object.values(users).map((u) => u.id));
  cleanupRunUploads(uploadsBefore);

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('\n冒烟测试异常：', err);
  process.exit(1);
});
