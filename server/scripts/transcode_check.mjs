// scripts/transcode_check.mjs
//
// 音视频转码回归：把「什么格式要转、转完的副本长什么样、原件有没有被动过」
// 钉成断言。改 transcode.js 的白名单 / ffmpeg 参数时先跑它。
//
// 策略（有意为之，不是遗漏）：
//   · 已经能播的（mp4/h264+aac、mp3、flac、webm/vp8+vorbis）→ **不转**，
//     连 tc/ 目录里都不该出现副本；
//   · 编码对、容器不对（mkv 里装 h264+aac）→ 只换壳（remux），秒级；
//   · 编码不对（avi/mpeg4、wma/wmav2）→ 真转码；
//   · **容器对、编码不对**（.mp4 里装 HEVC）也要转 —— 只看扩展名的实现会漏掉它；
//   · 不是媒体的假 .mp4 → 识别不出来就放行原样（前端自然会退回卡片），不报错。
//
// 自包含：临时配置 + 临时空库 + 临时上传目录，自己拉起隔离端口的实例，
// 跑完杀掉并删干净。不碰 chat.db，也不写 uploads/。
// 需要本机有 ffmpeg / ffprobe（这正是被测对象）。
//
// 用法：cd server && node scripts/transcode_check.mjs
//
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
// 被测的不只是服务端：客户端那套播放状态机是纯函数，顺手在这里一起钉住
import {
  initialMedia, nextMediaState
} from '../../client/src/utils/mediaPlayback.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tccheck-'));
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

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8', windowsHide: true
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg 生成测试素材失败（${r.status}）：${(r.stderr || r.error?.message || '').trim()}`);
  }
}

function ffprobeJson(file) {
  const r = spawnSync('ffprobe', [
    '-hide_banner', '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout || '{}'); } catch { return null; }
}

const codecOf = (file, type) => {
  const j = ffprobeJson(file);
  const s = (j?.streams || []).find((x) => x.codec_type === type);
  return s?.codec_name || null;
};
const formatOf = (file) => (ffprobeJson(file)?.format?.format_name || '');
const sha256FromBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256 = (file) => sha256FromBuf(fs.readFileSync(file));

// ============================================================
// 1. 生成测试素材（1 秒 160x120，编得快）
// ============================================================
const FIX = path.join(TMP, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });
const GEN = '-f lavfi -i testsrc=size=160x120:rate=10 -f lavfi -i sine=frequency=440:duration=1 -t 1';
const gen = (name, args) => {
  const p = path.join(FIX, name);
  ffmpeg([...GEN.split(' '), ...args, p]);
  return p;
};

console.log('\n\x1b[36m0. 生成测试素材\x1b[0m');
const FILES = {
  // 浏览器直接能播
  'native.mp4': { args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], mime: 'video/mp4', native: true },
  'native.webm': { args: ['-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libvorbis'], mime: 'video/webm', native: true },
  'native.mp3': { args: ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k'], mime: 'audio/mpeg', native: true },
  'native.flac': { args: ['-vn', '-c:a', 'flac'], mime: 'audio/flac', native: true },
  // 编码对、容器不对 → 换壳
  'remux.mkv': { args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], mime: 'video/x-matroska', action: 'remux', outExt: 'mp4' },
  // 编码不对 → 真转码
  'old.avi': { args: ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'], mime: 'video/x-msvideo', action: 'transcode', outExt: 'mp4' },
  'sound.wma': { args: ['-vn', '-c:a', 'wmav2'], mime: 'audio/x-ms-wma', action: 'transcode', outExt: 'mp3' },
  // 容器对、编码不对（最容易漏的一种）
  'hevc.mp4': { args: ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], mime: 'video/mp4', action: 'transcode', outExt: 'mp4' },
  // 名字像视频、内容不是媒体
  'fake.mp4': { raw: Buffer.from('这不是视频，只是一段文字冒充 .mp4\n', 'utf8'), mime: 'video/mp4', native: true }
};
for (const [name, spec] of Object.entries(FILES)) {
  if (spec.raw) fs.writeFileSync(path.join(FIX, name), spec.raw);
  else gen(name, spec.args);
  console.log(`  \x1b[90m${name.padEnd(13)} ${spec.raw ? '（假文件）' : `v=${codecOf(path.join(FIX, name), 'video') || '-'} a=${codecOf(path.join(FIX, name), 'audio') || '-'}`}\x1b[0m`);
}

// ============================================================
// 2. 起隔离实例
// ============================================================
const port = await freePort(3041);
const cfgFile = path.join(TMP, 'tc.yaml');
const uploadRoot = path.join(TMP, 'uploads').replace(/\\/g, '/');
fs.writeFileSync(cfgFile, SHIPPED
  .replace('  port: 3001', `  port: ${port}`)
  .replace('  path: chat.db', `  path: ${path.join(TMP, 'tc.db').replace(/\\/g, '/')}`)
  .replace('  root: uploads', `  root: ${uploadRoot}`), 'utf8');

const logFile = path.join(TMP, 'tc.log');
const fd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, APP_CONFIG: cfgFile, PORT: undefined, HOST: undefined, SERVE_CLIENT: '0' },
  stdio: ['ignore', fd, fd]
});

const BASE = `http://127.0.0.1:${port}`;
const FILES_DIR = path.join(TMP, 'uploads', 'files');
const TC_DIR = path.join(FILES_DIR, 'tc');
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
    body: JSON.stringify({ username: `tc_${TS}`, password: 'pass1234', nickname: '转码探针' })
  });
  const { token } = await reg.json();
  if (!token) throw new Error('注册失败');
  const auth = { Authorization: `Bearer ${token}` };

  // ---- ffmpeg 就绪 ----
  console.log('\n\x1b[36m1. ffmpeg 探测\x1b[0m');
  const diag = await (await fetch(`${BASE}/api/media/transcode`, { headers: auth })).json();
  ok(diag.available === true, `后端识别到本地 ffmpeg（${diag.version || diag.error}）`, diag);
  const anon = await fetch(`${BASE}/api/media/transcode`);
  ok(anon.status === 401, '诊断口要鉴权（未登录 401）', anon.status);

  const uploadOne = async (name) => {
    const spec = FILES[name];
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(FIX, name))], { type: spec.mime }), name);
    const res = await fetch(`${BASE}/api/file`, { method: 'POST', headers: auth, body: form });
    const data = await res.json();
    if (res.status !== 200) throw new Error(`上传 ${name} 失败：${JSON.stringify(data)}`);
    return data;
  };

  const statusOf = async (src) => {
    const r = await fetch(`${BASE}/api/media/status?src=${encodeURIComponent(src)}`, { headers: auth });
    return { code: r.status, body: await r.json() };
  };

  const waitSettled = async (src, tries = 120, gap = 500) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = (await statusOf(src)).body;
      if (['ready', 'failed', 'not_needed', 'unsupported'].includes(last.status)) return last;
      await sleep(gap);
    }
    return last;
  };

  const originFileOf = (url) => path.join(FILES_DIR, path.basename(url));
  const tcFileOf = (url) => path.join(TC_DIR, path.basename(url));

  // ---- 逐个格式 ----
  console.log('\n\x1b[36m2. 上传响应里的转码计划\x1b[0m');
  const uploaded = {};
  for (const name of Object.keys(FILES)) {
    const spec = FILES[name];
    const before = sha256(path.join(FIX, name));
    const data = await uploadOne(name);
    uploaded[name] = data;
    const pb = data.playback;

    if (spec.native) {
      ok(pb && pb.needed === false, `${name} 判定为「浏览器能直接播」`, pb);
      ok(pb && pb.status === 'not_needed', `${name} 状态 = not_needed`, pb?.status);
    } else {
      const wantAction = spec.action;
      // 可播地址由**服务端分配的文件名**推导（上传会重命名），不是原始文件名
      const base = path.basename(data.url, path.extname(data.url));
      const wantUrl = `/uploads/files/tc/${base}.${spec.outExt}`;
      ok(pb && pb.needed === true, `${name} 判定为「需要转码」（${wantAction}）`, pb);
      ok(pb?.status === 'pending', `${name} 上传当下状态 = pending`, pb?.status);
      ok(pb?.playUrl === wantUrl, `${name} 给出可播地址 ${wantUrl}`, pb?.playUrl);
      ok(typeof pb?.reason === 'string' && pb.reason.length > 0, `${name} 附了人可读的理由：${pb?.reason}`);
    }
    // 原件必须原样躺在那里，且没被改过一个字节
    ok(fs.existsSync(originFileOf(data.url)), `${name} 原件保留在 uploads/files/`);
    ok(sha256(originFileOf(data.url)) === before, `${name} 原件字节未被改动`);
  }

  console.log('\n\x1b[36m3. 转码结果（轮询 /api/media/status）\x1b[0m');
  for (const [name, spec] of Object.entries(FILES)) {
    const data = uploaded[name];
    const fin = await waitSettled(data.url);

    if (spec.native) {
      ok(fin.status === 'not_needed', `${name} 不需要转码，状态保持 not_needed`, fin);
      const strayTc = fs.existsSync(TC_DIR) ? fs.readdirSync(TC_DIR) : [];
      const base = path.basename(data.url, path.extname(data.url));
      ok(!strayTc.some((f) => f.startsWith(`${base}.`)),
        `${name} 没有产生多余的 tc/ 副本`);
      continue;
    }

    ok(fin.status === 'ready', `${name} 转码完成（ready）`, fin);
    if (fin.status !== 'ready') continue;

    const out = tcFileOf(fin.playUrl);
    ok(fs.existsSync(out), `${name} 副本已落位 ${path.relative(TMP, out)}`);
    ok(!fs.existsSync(`${out}.part`), `${name} 没有残留 .part 半成品`);

    if (spec.outExt === 'mp4') {
      ok(codecOf(out, 'video') === 'h264', `${name} 副本视频编码 = h264`, codecOf(out, 'video'));
      ok(codecOf(out, 'audio') === 'aac', `${name} 副本音频编码 = aac`, codecOf(out, 'audio'));
      const fmt = formatOf(out);
      ok(/mp4|mov/.test(fmt), `${name} 副本容器 = mp4`, fmt);
      ok(fs.statSync(out).size > 0, `${name} 副本非空（${fs.statSync(out).size} 字节）`);
    } else {
      ok(codecOf(out, 'audio') === 'mp3', `${name} 副本音频编码 = mp3`, codecOf(out, 'audio'));
      ok(codecOf(out, 'video') === null, `${name} 副本没有视频流（纯音频）`, codecOf(out, 'video'));
    }

    // 浏览器真正要的是「这个地址能取到、能拖进度条」
    const head = await fetch(`${BASE}${fin.playUrl}`);
    ok(head.status === 200, `${name} 副本地址可直接取（200）`, head.status);
    ok(Number(head.headers.get('content-length')) > 0, `${name} 副本带 Content-Length（播放器要用来算时长/拖动）`);
    if (head.body) await head.body.cancel();
    const range = await fetch(`${BASE}${fin.playUrl}`, { headers: { Range: 'bytes=0-99' } });
    ok(range.status === 206, `${name} 副本支持 Range（可拖动进度条）`, range.status);
    if (range.body) await range.body.cancel();

    // 幂等：再问一次还是 ready，且不会重新入队
    const again = await statusOf(data.url);
    ok(again.body.status === 'ready', `${name} 重复查询仍然 ready（幂等，不重复转码）`, again.body.status);

    // 原件仍可原样下载
    const orig = await fetch(`${BASE}${data.url}`);
    ok(orig.status === 200, `${name} 原件地址仍可下载（没被副本顶掉）`, orig.status);
    if (orig.body) await orig.body.cancel();
  }

  console.log('\n\x1b[36m4. 历史附件自愈（没有上传响应也能转）\x1b[0m');
  {
    // 模拟「转码功能上线前就存在的老附件」：直接丢一个文件进 uploads/files，
    // 从没经过上传接口，只靠 /api/media/status 就应该被接手转码。
    const legacyName = `1700000000000_legacy.mkv`;
    fs.copyFileSync(path.join(FIX, 'remux.mkv'), path.join(FILES_DIR, legacyName));
    const src = `/uploads/files/${legacyName}`;
    const fin = await waitSettled(src);
    ok(fin.status === 'ready', '老附件第一次被查询即入队并转码完成', fin);
    ok(fin.playUrl === '/uploads/files/tc/1700000000000_legacy.mp4', '老附件的副本地址可推导', fin.playUrl);
    const out = tcFileOf(fin.playUrl);
    ok(fs.existsSync(out) && codecOf(out, 'video') === 'h264', '老附件副本确实是可播的 h264');
  }

  console.log('\n\x1b[36m5. 商城试看（同一套转码，走鉴权通道）\x1b[0m');
  {
    // 上架要 list_products（50 级）：隔离库里把探针账号直接提成管理员。
    // REST 每个请求都重查用户（auth/index.js loadUser），所以提权立刻生效。
    const local = new DatabaseSync(path.join(TMP, 'tc.db'));
    local.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(`tc_${TS}`);
    local.close();

    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(FIX, 'remux.mkv'))], { type: 'video/x-matroska' }), 'remux.mkv');
    form.append('name', 'remux.mkv');
    const sr = await fetch(`${BASE}/api/shop/upload`, { method: 'POST', headers: auth, body: form });
    const up = await sr.json();
    ok(sr.status === 200 && String(up.url).startsWith('/uploads/shop/'), '商品视频落到 uploads/shop', up);
    ok(up.playback?.needed === true, '商品视频同样当场给出转码计划', up.playback);

    const cr = await fetch(`${BASE}/api/shop/products`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `转码试看 ${TS}`,
        description: '转码回归用例',
        price: 0,
        market: 'standard',
        files: [{ url: up.url, name: 'remux.mkv', type: 'video/x-matroska', size: up.size, isPreview: true }]
      })
    });
    const created = await cr.json();
    ok(cr.status === 200 && !!created.id, '商品上架成功', created);

    const detail = await (await fetch(`${BASE}/api/shop/products/${created.id}`, { headers: auth })).json();
    const pf = (detail.files || []).find((f) => f.isPreview);
    ok(!!pf, '详情里能拿到勾了「预览」的文件', detail.files);

    // 不带 playback：必须原样给源文件（卖家/买家拿到的交付物不能被转码顶掉）
    const raw = await fetch(`${BASE}/api/shop/preview/${created.id}/${pf.id}`, { headers: auth });
    const rawBuf = Buffer.from(await raw.arrayBuffer());
    ok(raw.status === 200 && sha256FromBuf(rawBuf) === sha256(path.join(FIX, 'remux.mkv')),
      '普通预览通道给的仍是**原件**（逐字节相同）');

    // 带 playback：要么已经转好（200 mp4），要么还在转（202 + 进度）
    let pb = await fetch(`${BASE}/api/shop/preview/${created.id}/${pf.id}?playback=1`, { headers: auth });
    let firstStatus = pb.status;
    ok(firstStatus === 200 || firstStatus === 202, `试看 playback 通道首次回应 200/202（实际 ${firstStatus}）`, firstStatus);
    if (firstStatus === 202) {
      const body = await pb.json();
      ok(body.status === 'pending' && 'progress' in body, '202 里带 pending 状态与进度字段', body);
    } else {
      // 素材很小、可能在上架这几步之间就转完了：那就必须已经是 mp4
      ok(/video\/mp4/.test(pb.headers.get('content-type') || ''),
        '试看已经就绪时首次即 200，且给的是 mp4', pb.headers.get('content-type'));
    }

    let done = firstStatus === 200 ? pb : null;
    for (let i = 0; !done && i < 60; i++) {
      await sleep(500);
      const r = await fetch(`${BASE}/api/shop/preview/${created.id}/${pf.id}?playback=1`, { headers: auth });
      if (r.status === 200) done = r;
      else if (r.status !== 202) { ok(false, '试看转码失败', r.status); break; }
    }
    ok(!!done, '轮询到试看视频可播（200）');
    if (done) {
      const buf = Buffer.from(await done.arrayBuffer());
      const outFile = path.join(TMP, 'shop-preview.bin');
      fs.writeFileSync(outFile, buf);
      ok(codecOf(outFile, 'video') === 'h264', '试看副本是 h264（浏览器能播）', codecOf(outFile, 'video'));
      ok(codecOf(outFile, 'audio') === 'aac', '试看副本音轨是 aac', codecOf(outFile, 'audio'));
      ok(sha256FromBuf(buf) !== sha256(path.join(FIX, 'remux.mkv')), '试看给的确实是转码副本，不是源文件');
    }

    // 交付下载不受影响：卖家下到的仍是原件
    const dl = await fetch(`${BASE}/api/shop/download/${created.id}/${pf.id}`, { headers: auth });
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    ok(dl.status === 200 && sha256FromBuf(dlBuf) === sha256(path.join(FIX, 'remux.mkv')),
      '下载通道不受转码影响，交付的仍是原件');
  }

  console.log('\n\x1b[36m6. 前端播放状态机（纯函数）\x1b[0m');
  {
    // 客户端那套「direct → waiting → play / fallback」是纯函数（utils/mediaPlayback.js），
    // 不需要浏览器就能钉住 —— 它决定用户到底看到播放器、进度条还是文件卡片。
    const mk = (over) => ({
      id: 'm1', roomType: 'group', senderId: 2, senderName: 'x', senderAvatar: '',
      text: '', replyTo: null, isSticker: false, readBy: [], createdAt: Date.now(),
      fileUrl: '/uploads/files/a.mkv', fileName: 'a.mkv', fileType: 'video', fileSize: 1,
      ...over
    });

    ok(initialMedia(mk({})).phase === 'waiting',
      'mkv 视频：一上来就进等待态（不白下一次注定失败的加载）');
    ok(initialMedia(mk({ fileName: 'a.mp4' })).phase === 'direct',
      'mp4：先按原地址试播（能播就零开销）');
    ok(initialMedia(mk({ fileName: 'a.wma', fileType: 'audio' })).phase === 'waiting',
      'wma 音频同样直接进等待态');
    ok(initialMedia(mk({ fileType: 'file', fileName: 'a.zip' })).phase === 'direct',
      '普通文件不参与播放状态机');
    ok(initialMedia(mk({ isSticker: true })).phase === 'direct',
      '表情（贴纸）不参与播放状态机');

    const waiting = { phase: 'waiting', tried: false };
    const pend = nextMediaState(waiting, { status: 'pending', progress: 0.42, reason: '转码中' });
    ok(pend.phase === 'waiting' && pend.progress === 0.42, 'pending → 继续等待并带上进度', pend);

    const ready = nextMediaState(waiting, { status: 'ready', playUrl: '/uploads/files/tc/a.mp4' });
    ok(ready.phase === 'play' && ready.playUrl === '/uploads/files/tc/a.mp4',
      'ready → 切到可播副本地址', ready);

    const failed = nextMediaState(waiting, { status: 'failed', error: '磁盘满了' });
    ok(failed.phase === 'fallback' && /磁盘满了/.test(failed.note), 'failed → 退回卡片并把原因说清楚', failed);

    ok(nextMediaState({ phase: 'waiting', tried: true }, { status: 'not_needed' }).phase === 'fallback',
      '服务端说不用转、但原地址已经播失败过 → 退回卡片');
    ok(nextMediaState({ phase: 'waiting', tried: false }, { status: 'not_needed' }).phase === 'direct',
      '服务端说不用转、且还没试过原地址 → 回去原样播');
    ok(nextMediaState({ phase: 'waiting', tried: false }, { status: 'unavailable' }).phase === 'direct',
      '后端没装 ffmpeg（unavailable）→ 回退成旧行为，而不是卡在等待态');
    ok(nextMediaState({ phase: 'waiting', tried: true }, null).phase === 'waiting',
      '状态查询本身失败 → 保持等待（网络抖动不该把附件判死刑）');

    const kept = nextMediaState({ phase: 'waiting', tried: false, stalled: true, retryNonce: 3 },
      { status: 'pending', progress: 0.1 });
    ok(kept.stalled === true && kept.retryNonce === 3,
      '状态迁移不丢渲染字段（stalled / retryNonce 原样带回）', kept);
  }

  console.log('\n\x1b[36m7. 边界与安全\x1b[0m');
  {
    const noToken = await fetch(`${BASE}/api/media/status?src=%2Fuploads%2Ffiles%2Fwhatever.mkv`);
    ok(noToken.status === 401, '未登录查询转码状态 → 401', noToken.status);

    const traversal = await statusOf('/uploads/files/../../chat.db');
    ok(traversal.code === 400, '路径穿越（..）→ 400', traversal);
    const otherDir = await statusOf('/uploads/avatars/x.png');
    ok(otherDir.code === 400, '只受理 uploads/files（avatars 被拒）→ 400', otherDir);
    const nested = await statusOf('/uploads/files/tc/x.mp4');
    ok(nested.code === 400, '副本目录不可被查询（单层文件名）→ 400', nested);
    const missing = await statusOf('/uploads/files/1790000000000_nope.mkv');
    ok(missing.code === 404, '不存在的附件 → 404', missing.code);

    const fake = await statusOf(uploaded['fake.mp4'].url);
    ok(fake.body.needed === false, '冒充 .mp4 的非媒体文件被放行（退回卡片，而不是报错）', fake.body);

    const leftPart = fs.existsSync(TC_DIR)
      ? fs.readdirSync(TC_DIR).filter((f) => f.endsWith('.part')) : [];
    ok(leftPart.length === 0, '整轮跑完 tc/ 里没有任何 .part 残留', leftPart);
  }

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n转码回归异常：', err);
  try { console.error('--- 服务端日志尾部 ---\n' + fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n')); } catch { /* ignore */ }
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
