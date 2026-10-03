// src/services/transcode.js
//
// 本地 ffmpeg 转码：让「任何格式的音视频附件都能在浏览器里播」。
//
// 为什么需要它：浏览器只认有限的「容器 + 编码」组合（mp4/mov 里的 h264+aac、
// webm 里的 vp8/vp9/av1+opus/vorbis、mp3/m4a/flac/wav…）。用户从手机、录屏、
// 下载器里拖进来的 mkv / avi / flv / wmv / rmvb / wma 一律「能存不能播」，
// 前端只能退回文件卡片让用户自己下载后用本地播放器打开。
//
// 设计决策（每条都会牵动别的模块，改之前先读完）：
//   1. 只产**副本**，绝不碰原件 —— 下载 / 商品交付拿到的永远是原文件；
//   2. 输出路径由源文件名**确定性推导**：
//        uploads/files/tc/<basename>.mp4|.m4a|.mp3
//      不落库、不加字段。历史消息、其他客户端、REST 通道都不用改协议 ——
//      任意一端问一句 /api/media/status 就知道「该播哪个地址 / 转好了没」；
//   3. ffprobe 同步跑（几十毫秒，带结果缓存）判断「要不要转」；ffmpeg 走
//      **后台队列**，绝不阻塞上传请求；接口只回状态，客户端轮询；
//   4. 编码已经浏览器友好、只是容器不对（mkv/avi 里装 h264+aac）→ 只 remux
//      （-c copy），通常秒级完成；remux 失败自动退回全量转码；
//   5. 输出先写 *.part，成功后 rename 原子落位 —— 静态目录里绝不会出现半截
//      mp4（否则浏览器会拿到一个「播到一半戛然而止」的文件，比不能播更糟）；
//   6. ffmpeg 缺失 / 未开启 → 全链路静默降级成旧行为（原样播 / 退回卡片），
//      不抛错、不影响上传。
//
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');

const CFG = config.TRANSCODE_CFG;

// 转码输出统一放在源目录下的 tc/ 子目录（与源文件同名，只换扩展名）。
// files 目录是静态暴露的，所以 /uploads/files/tc/x.mp4 浏览器能直接取；
// shop 目录不暴露，只能走 /api/shop/preview/... 鉴权通道（见 routes/download.js）。
const TC_DIRNAME = 'tc';

// ============================================================
// 容器 / 编码白名单：浏览器「能直接播」的判定标准
// ============================================================
// 判定分两层：容器（扩展名）必须对，编码也必须对。
// 只看扩展名会漏掉「.mp4 里装 HEVC」（Chrome 多数情况解不了）这类陷阱，
// 只看编码会漏掉「.mkv 里装 h264」（容器不支持）。
const MP4_LIKE = new Set(['mp4', 'm4v', 'mov']);
const WEBM_LIKE = new Set(['webm']);
const VIDEO_EXT_OK = new Set([...MP4_LIKE, ...WEBM_LIKE]);

const AUDIO_EXT_OK = new Set([
  'mp3', 'm4a', 'mp4', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'webm'
]);

// 能被浏览器直接解码的视频编码（按容器分别判定，见 videoIsNative）
const H264 = 'h264';
const WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO_CODECS = new Set(['opus', 'vorbis']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3']);

// 能直接「原样搬进新容器」的音频编码（remux 用）
const REMUX_AUDIO_EXT = { aac: 'm4a', mp3: 'mp3' };

function videoIsNative(ext, vcodec, acodec) {
  if (!VIDEO_EXT_OK.has(ext) || !vcodec) return false;
  if (WEBM_LIKE.has(ext)) {
    return WEBM_VIDEO_CODECS.has(vcodec)
      && (!acodec || WEBM_AUDIO_CODECS.has(acodec));
  }
  return vcodec === H264 && (!acodec || MP4_AUDIO_CODECS.has(acodec));
}

function audioIsNative(ext, acodec) {
  if (!AUDIO_EXT_OK.has(ext) || !acodec) return false;
  if (ext === 'mp3') return acodec === 'mp3';
  if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return acodec === 'aac';
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') {
    return acodec === 'vorbis' || acodec === 'opus';
  }
  if (ext === 'weba' || ext === 'webm') {
    return acodec === 'opus' || acodec === 'vorbis';
  }
  if (ext === 'flac') return acodec === 'flac';
  if (ext === 'wav') return /^pcm_/.test(acodec);
  return false;
}

// ============================================================
// 工具
// ============================================================
function extOf(p) {
  return (path.extname(p) || '').replace(/^\./, '').toLowerCase();
}

/** 输出地址：uploads/files/x.mkv → uploads/files/tc/x.mp4 */
// [NOTE] 只按「同目录 + 同 basename」推导，因此**同一目录内 basename 唯一**是前提：
//        上传接口本来就按 `{时间戳}_{随机}{扩展名}` 命名，天然满足。
//        万一将来有人手工往 uploads/files 里放一对 `x.avi` + `x.mkv`（都转 mp4），
//        会互相顶掉 —— 真要支持，就把源扩展名也编进副本名（`x.avi.mp4`），
//        客户端不受影响（播放地址始终由服务端下发，不靠推导）。
function outputPathFor(absSrc, outExt) {
  const base = path.basename(absSrc, path.extname(absSrc));
  return path.join(path.dirname(absSrc), TC_DIRNAME, `${base}.${outExt}`);
}

/** 绝对路径 → 对外 URL（/uploads/...）。只用于 uploads 根目录下的文件 */
function urlForAbs(absPath) {
  const rel = path.relative(config.UPLOAD_ROOT, absPath).split(path.sep).join('/');
  return `/uploads/${rel}`;
}

function isInsideUploadRoot(absPath) {
  const root = path.resolve(config.UPLOAD_ROOT);
  const target = path.resolve(absPath);
  return target === root || target.startsWith(root + path.sep);
}

// ============================================================
// ffmpeg / ffprobe 探测（只做一次，结果缓存）
// ============================================================
let detectCache = null;

function detect() {
  if (detectCache) return detectCache;

  if (!CFG.enabled) {
    detectCache = { ok: false, error: '配置里已关闭 media.transcode.enabled' };
    console.log('[transcode] 已按配置关闭：音视频附件按原样播放（播不了退回卡片）');
    return detectCache;
  }

  // 这里用同步调用是有意的：只在**首次用到时**跑一次 `-version`（几十毫秒），
  // 之后全部走缓存；探测真实文件的那条路径是异步的（见 probeSpawn）。
  const probe = spawnSync(CFG.ffprobe, ['-hide_banner', '-version'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  const ffmpeg = spawnSync(CFG.ffmpeg, ['-hide_banner', '-version'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true
  });

  if (probe.error || probe.status !== 0) {
    detectCache = {
      ok: false,
      error: `找不到可用的 ffprobe（${CFG.ffprobe}）：${probe.error?.message || `退出码 ${probe.status}`}`
    };
    console.warn(`[transcode] ${detectCache.error}`);
    console.warn('[transcode] 已降级：音视频附件按原样播放（播不了退回卡片）。装了 ffmpeg 后重启后端即可生效');
    return detectCache;
  }
  if (ffmpeg.error || ffmpeg.status !== 0) {
    detectCache = {
      ok: false,
      error: `找不到可用的 ffmpeg（${CFG.ffmpeg}）：${ffmpeg.error?.message || `退出码 ${ffmpeg.status}`}`
    };
    console.warn(`[transcode] ${detectCache.error}`);
    console.warn('[transcode] 已降级：音视频附件按原样播放（播不了退回卡片）');
    return detectCache;
  }

  const version = String(ffmpeg.stdout || '').split('\n')[0].trim();
  detectCache = { ok: true, version, ffmpeg: CFG.ffmpeg, ffprobe: CFG.ffprobe };
  console.log(`[transcode] ffmpeg 就绪：${version}`);
  return detectCache;
}

function isAvailable() {
  return detect().ok;
}

// ============================================================
// ffprobe：解析出「有没有视频流 / 音频流、编码是什么、时长多少」
// ============================================================
// 缓存键带上 size + mtime：文件被替换（同名重传）时自动失效。
const probeCache = new Map();
const PROBE_CACHE_MAX = 500;

// [NOTE] 探测必须**异步**跑：它是请求路径上的一步（上传接口要当场回计划）。
//        用 spawnSync 的话，一个畸形文件就能把整个事件循环按住（最长 probe_timeout_ms），
//        期间所有请求 / socket 心跳全部停摆 —— 这是同一条链路上最容易埋进去的雷。
function probeSpawn(absSrc) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      absSrc
    ];
    let child;
    try {
      child = spawn(CFG.ffprobe, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let out = '';
    let errOut = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, CFG.probe_timeout_ms);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { errOut = (errOut + c).slice(-500); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, error: `探测超时（${CFG.probe_timeout_ms}ms）` });
      if (code !== 0) return resolve({ ok: false, error: `ffprobe 退出码 ${code}${errOut ? `：${errOut.trim()}` : ''}` });

      let data;
      try {
        data = JSON.parse(out || '{}');
      } catch {
        return resolve({ ok: false, error: 'ffprobe 输出无法解析' });
      }
      const streams = Array.isArray(data.streams) ? data.streams : [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const duration = Number(data.format?.duration || v?.duration || a?.duration || 0);
      resolve({
        ok: true,
        hasVideo: !!v,
        hasAudio: !!a,
        vcodec: v?.codec_name || null,
        acodec: a?.codec_name || null,
        format: data.format?.format_name || null,
        durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0
      });
    });
  });
}

/** 带缓存的探测。文件不存在 / 不是媒体 → { ok:false } */
async function probe(absSrc) {
  let st;
  try {
    st = fs.statSync(absSrc);
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  if (!st.isFile()) return { ok: false, error: '不是文件' };

  const key = `${absSrc}|${st.size}|${st.mtimeMs}`;
  const hit = probeCache.get(key);
  if (hit) return hit;

  const result = await probeSpawn(absSrc);
  if (probeCache.size >= PROBE_CACHE_MAX) {
    // 简单的 FIFO 淘汰：Map 保持插入顺序，删最早的那个
    probeCache.delete(probeCache.keys().next().value);
  }
  probeCache.set(key, result);
  return result;
}

// ============================================================
// 计划：这个文件该怎么处理
// ============================================================
//   action: 'none'      已经能播，什么都不用做
//           'remux'     编码 OK 只是容器不对 → -c copy 换壳
//           'transcode' 真转码
/**
 * @param {object} probeResult `await probe(absSrc)` 的结果（必须传：见 probeSpawn 的说明）
 * @returns {{needed:boolean, action:'none'|'remux'|'transcode',
 *            outExt:string|null, reason:string, probe:object}}
 */
function planFor(absSrc, probeResult) {
  const ext = extOf(absSrc);
  const p = probeResult || { ok: false, error: '缺少探测结果' };

  if (!p.ok) {
    return { needed: false, action: 'none', outExt: null, reason: `无法识别为媒体文件（${p.error}）`, probe: p };
  }
  if (!p.hasVideo && !p.hasAudio) {
    return { needed: false, action: 'none', outExt: null, reason: '没有音视频流', probe: p };
  }

  if (p.hasVideo) {
    if (videoIsNative(ext, p.vcodec, p.acodec)) {
      return { needed: false, action: 'none', outExt: null, reason: `${ext} + ${p.vcodec}/${p.acodec || '无音轨'} 浏览器可直接播放`, probe: p };
    }
    if (p.vcodec === H264 && (!p.acodec || MP4_AUDIO_CODECS.has(p.acodec))) {
      return { needed: true, action: 'remux', outExt: 'mp4', reason: `h264/${p.acodec || '无音轨'} 只是容器（${ext}）不对，换个壳即可`, probe: p };
    }
    return { needed: true, action: 'transcode', outExt: 'mp4', reason: `${ext} + ${p.vcodec}/${p.acodec || '无音轨'} 浏览器解不了，转成 h264/aac`, probe: p };
  }

  // 纯音频
  if (audioIsNative(ext, p.acodec)) {
    return { needed: false, action: 'none', outExt: null, reason: `${ext} + ${p.acodec} 浏览器可直接播放`, probe: p };
  }
  const remuxExt = REMUX_AUDIO_EXT[p.acodec];
  if (remuxExt) {
    return { needed: true, action: 'remux', outExt: remuxExt, reason: `${p.acodec} 只是容器（${ext}）不对，换个壳即可`, probe: p };
  }
  return { needed: true, action: 'transcode', outExt: 'mp3', reason: `${ext} + ${p.acodec} 浏览器解不了，转成 mp3`, probe: p };
}

// ============================================================
// 队列
// ============================================================
const jobs = new Map();       // outAbs → job（排队中 / 运行中）
const failures = new Map();   // outAbs → { at, error }（已失败，避免轮询反复重试）
const FAILURE_MAX = 200;
// [FIX] 失败记录加 TTL：原先只按 FIFO 淘汰，同一文件转码失败后
//       在进程生命周期内永远 failed（比如临时性的磁盘满 / 队列抖动）。
const FAILURE_TTL_MS = 30 * 60 * 1000; // 30 分钟后允许重试
const queue = [];
let running = 0;

function stats() {
  return {
    running,
    queued: queue.length,
    jobs: jobs.size,
    failures: failures.size
  };
}

function enqueue(absSrc, plan) {
  const outAbs = outputPathFor(absSrc, plan.outExt);
  const existing = jobs.get(outAbs);
  if (existing) return existing;

  const job = {
    outAbs,
    srcAbs: absSrc,
    partAbs: `${outAbs}.part`,
    srcUrl: urlForAbs(absSrc),
    playUrl: urlForAbs(outAbs),
    plan,
    status: 'pending',      // pending | running
    progress: 0,
    error: null,
    enqueuedAt: Date.now()
  };
  jobs.set(outAbs, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < CFG.concurrency && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    runJob(job)
      .catch((err) => {
        console.error('[transcode] 任务异常', job.outAbs, err);
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

async function runJob(job) {
  const started = Date.now();
  fs.mkdirSync(path.dirname(job.outAbs), { recursive: true });
  job.status = 'running';
  job.progress = 0;

  let plan = job.plan;
  let attempt = 0;
  // 第一次按计划跑；remux 失败时退回全量转码再试一次（换壳失败通常是
  // 编码参数与 mp4 不兼容，这时只有真转码才救得回来）。
  for (;;) {
    attempt += 1;
    try {
      await runFfmpeg(job, plan);
      fs.renameSync(job.partAbs, job.outAbs);   // 原子落位
      job.status = 'done';
      job.progress = 1;
      jobs.delete(job.outAbs);
      failures.delete(job.outAbs);
      console.log(
        `[transcode] ${plan.action === 'remux' ? '换壳' : '转码'}完成 `
        + `${path.basename(job.srcAbs)} → ${path.basename(job.outAbs)} `
        + `（${((Date.now() - started) / 1000).toFixed(1)}s）`
      );
      return;
    } catch (err) {
      safeUnlink(job.partAbs);
      const msg = err?.message || String(err);
      if (plan.action === 'remux' && attempt === 1) {
        console.warn(`[transcode] 换壳失败，改为全量转码：${path.basename(job.srcAbs)} —— ${msg}`);
        plan = {
          ...plan,
          action: 'transcode',
          reason: `${plan.reason}；换壳失败（${msg}），已改为全量转码`
        };
        continue;
      }
      job.status = 'failed';
      job.error = msg;
      jobs.delete(job.outAbs);
      if (failures.size >= FAILURE_MAX) failures.delete(failures.keys().next().value);
      failures.set(job.outAbs, { at: Date.now(), error: msg });
      console.error(`[transcode] 失败：${path.basename(job.srcAbs)} —— ${msg}`);
      return;
    }
  }
}

function safeUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* 清理失败不致命 */
  }
}

function ffmpegArgs(job, plan) {
  const base = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-i', job.srcAbs];
  // 输出先写 *.part（原子落位用），扩展名不是 ffmpeg 认得的，所以**必须显式 -f 指定封装**。
  // 这也是刻意选的：半成品带 .part 后缀，静态托管只会把它当 octet-stream，
  // 不会像「半截 .mp4」那样被浏览器当视频加载。
  const mux = plan.outExt === 'mp3' ? ['-f', 'mp3'] : ['-f', 'mp4'];

  if (plan.action === 'remux') {
    if (plan.outExt === 'mp4') {
      return [...base, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', ...mux, job.partAbs];
    }
    if (plan.outExt === 'm4a') {
      // m4a 就是 mp4 容器（只是扩展名不同），-f mp4 足够，别去猜 ipod 这类封装器
      return [...base, '-vn', '-c:a', 'copy', '-movflags', '+faststart', ...mux, job.partAbs];
    }
    // mp3
    return [...base, '-vn', '-c:a', 'copy', ...mux, job.partAbs];
  }

  if (plan.outExt === 'mp3') {
    return [...base, '-vn', '-c:a', 'libmp3lame', '-b:a', CFG.audio.bitrate, ...mux, job.partAbs];
  }

  // 视频：h264 + aac，yuv420p 保证各浏览器/硬件解码器都认（10bit 源也能播）
  const args = [...base, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', CFG.video.preset, '-crf', String(CFG.video.crf),
    '-pix_fmt', 'yuv420p'];
  if (CFG.video.max_height > 0) {
    // 逗号在 filtergraph 里是参数分隔符，必须转义；不让 ffmpeg 放大低分辨率源
    args.push('-vf', `scale=-2:min(${CFG.video.max_height}\\,ih)`);
  }
  args.push('-c:a', 'aac', '-b:a', CFG.video.audio_bitrate, '-movflags', '+faststart', ...mux, job.partAbs);
  return args;
}

function runFfmpeg(job, plan) {
  return new Promise((resolve, reject) => {
    const args = ffmpegArgs(job, plan);
    let child;
    try {
      child = spawn(CFG.ffmpeg, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    job.progress = 0;
    let stderrTail = '';
    let killed = null;

    const timer = setTimeout(() => {
      killed = `转码超过 ${Math.round(CFG.timeout_ms / 1000)}s 上限，已中止`;
      try { child.kill(); } catch { /* ignore */ }
    }, CFG.timeout_ms);
    if (typeof timer.unref === 'function') timer.unref();

    const durationUs = (plan.probe?.durationSec || 0) * 1e6;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // -progress pipe:1 输出形如 out_time_us=1234567 / progress=continue
      const re = /out_time_us=(\d+)/g;
      let m;
      let last = null;
      while ((m = re.exec(chunk)) !== null) last = m[1];
      if (last !== null && durationUs > 0) {
        const p = Number(last) / durationUs;
        if (Number.isFinite(p)) job.progress = Math.max(0, Math.min(0.99, p));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(killed));
      if (code === 0) return resolve();
      return reject(new Error(`ffmpeg 退出码 ${code}${stderrTail ? `：${stderrTail.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

// ============================================================
// 对外：查状态（必要时顺手入队）
// ============================================================
const NOOP = { needed: false, status: 'not_needed', playUrl: null, progress: null, error: null, reason: '' };

/**
 * 询问「这个附件该怎么播」。
 * 这是**唯一**对外入口：上传接口用它回状态，客户端轮询也用它。
 * 副作用（入队转码）是幂等的：同一文件重复问只会复用同一个任务。
 *
 * @param {string} absSrc 源文件绝对路径（必须在 uploads 根目录内）
 * @param {{enqueue?:boolean}} options
 * @returns {Promise<{needed:boolean, status:string, playUrl:string|null,
 *                    progress:number|null, error:string|null, reason:string}>}
 */
async function describe(absSrc, { enqueue: allowEnqueue = true } = {}) {
  const det = detect();
  if (!det.ok) return { ...NOOP, status: 'unavailable', reason: det.error };
  if (!isInsideUploadRoot(absSrc)) {
    return { ...NOOP, status: 'unsupported', error: '不在上传目录内' };
  }

  let size = 0;
  try {
    size = fs.statSync(absSrc).size;
  } catch {
    return { ...NOOP, status: 'unsupported', error: '文件不存在' };
  }
  if (CFG.max_source_bytes > 0 && size > CFG.max_source_bytes) {
    return {
      ...NOOP,
      status: 'unsupported',
      reason: `文件超过转码上限（${Math.round(CFG.max_source_bytes / 1048576)}MB）`
    };
  }

  const p = await probe(absSrc);
  const plan = planFor(absSrc, p);
  if (!plan.needed) {
    return { ...NOOP, reason: plan.reason };
  }

  const outAbs = outputPathFor(absSrc, plan.outExt);
  const playUrl = urlForAbs(outAbs);

  const job = jobs.get(outAbs);
  if (job) {
    return {
      needed: true,
      status: 'pending',
      playUrl,
      progress: job.status === 'running' ? job.progress : 0,
      error: null,
      reason: plan.reason
    };
  }
  if (fs.existsSync(outAbs)) {
    return { needed: true, status: 'ready', playUrl, progress: 1, error: null, reason: plan.reason };
  }
  const bad = failures.get(outAbs);
  if (bad && Date.now() - bad.at < FAILURE_TTL_MS) {
    return { needed: true, status: 'failed', playUrl, progress: null, error: bad.error, reason: plan.reason };
  }
  if (bad) failures.delete(outAbs); // 过期失败记录：允许重新入队
  if (!allowEnqueue) {
    return { needed: true, status: 'pending', playUrl, progress: 0, error: null, reason: plan.reason };
  }
  if (queue.length >= CFG.max_queue) {
    // 队列满：不当失败处理。客户端轮询会再问一次，那时队列大概率已经消化了。
    return { needed: true, status: 'pending', playUrl, progress: null, error: null, reason: '转码队列繁忙，等待中' };
  }

  plan.probe = p;
  enqueue(absSrc, plan);
  return { needed: true, status: 'pending', playUrl, progress: 0, error: null, reason: plan.reason };
}

module.exports = {
  describe,
  probe,
  planFor,
  isAvailable,
  detect,
  outputPathFor,
  urlForAbs,
  stats,
  TC_DIRNAME
};
