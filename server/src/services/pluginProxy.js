// src/services/pluginProxy.js
//
// 插件代理：允许**有 proxy 白名单**的插件通过服务端访问外部 HTTPS 资源。
//
// 为什么需要它：
//   插件跑在沙箱 iframe 里，受到浏览器的同源策略限制 —— 即使我们放宽 CSP
//   的 connect-src，插件的 fetch 依然会被 CORS 拦截（浏览器内核拦的，不是
//   我们拦的）。要让插件能读跨域数据，唯一的路是**服务端去抓**。
//
// 安全边界：
//   · 白名单由**运维维护的独立 yaml** 决定（services/pluginWhitelist.js），
//     不再来自 manifest.proxy —— 这样重装插件不会覆盖白名单，也解除了
//     "只有 developer 能上传带 proxy 插件" 的限制（限制的目的本来就是防
//     未经运营确认的域名，现在由白名单承担）
//   · 白名单只允许 https origin（不允许通配符 / 路径 / query / fragment）
//   · 每次代理都校验目标 url 的 origin 在白名单里
//   · 有缓存 + 并发上限，避免被当成肉鸡刷外部接口
//
// 支持两种调用：
//   · fetchViaProxy —— 一次性拿回完整响应（有缓存）
//   · fetchViaProxyStream —— 返回上游流（**不缓存**，供 SSE / 大响应使用）
//
// 请求头白名单（路由层与这里**双层过滤**）：
//   authorization / content-type / accept / x-api-key
//   其余请求头一律丢弃 —— 防止插件借宿主代理伪造任意头打第三方接口。
//
const config = require('../config');

// ============================================================
// 请求头 / 体积白名单
// ============================================================
const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key']);
const MAX_REQUEST_BODY_BYTES  = 128 * 1024;      // 128 KB
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024; // 2 MB（仅限 fetchViaProxy）

// ============================================================
// 缓存：同 url + method + 关键请求头 + 请求体哈希，在 TTL 内复用
// （避免用户狂点触发外部限流）
// ============================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // cacheKey -> { at, status, contentType, body }

function cacheKeyOf(opts) {
  // 请求体可能很大，只做长度 + 前 64 字符的组合键，足够区分
  const b = opts.body || '';
  const bodyTag = b ? `${b.length}:${b.slice(0, 64)}` : '';
  return `${opts.method}|${opts.url}|${bodyTag}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  }
  // 超量时删最早插入的（Map 保持插入顺序）
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

// ============================================================
// 并发控制：同时最多 N 个外部请求；超出的排队（FIFO），再超则拒绝
// ============================================================
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 10;
let running = 0;
const queue = [];

function acquire() {
  return new Promise((resolve, reject) => {
    if (running < MAX_CONCURRENT) {
      running++;
      resolve();
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      reject(Object.assign(new Error('代理请求队列已满，请稍后再试'), { status: 503 }));
      return;
    }
    queue.push({ resolve });
  });
}

function release() {
  const next = queue.shift();
  if (next) {
    // 从队列里放一个出来，running 保持不变
    next.resolve();
  } else {
    running--;
  }
}

// ============================================================
// url 校验
// ============================================================
function originOf(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') {
    throw Object.assign(new Error('只允许 https'), { status: 400 });
  }
  return u.origin;
}

// ============================================================
// 通用：入参规范化 + 白名单校验（两种入口共用）
// ============================================================
function normalizeRequest(opts, allow) {
  const normalized = typeof opts === 'string'
    ? { url: opts, method: 'GET', headers: {}, body: null }
    : (opts || {});

  const url = String(normalized.url || '');
  const method = String(normalized.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const body = method === 'POST' && normalized.body ? String(normalized.body) : null;

  // 请求头白名单（与 routes/plugins.js 是**双保险**）
  const headers = {};
  if (normalized.headers && typeof normalized.headers === 'object') {
    for (const [k, v] of Object.entries(normalized.headers)) {
      const lk = String(k).toLowerCase();
      if (!ALLOWED_HEADERS.has(lk)) continue;
      if (typeof v !== 'string') continue;
      headers[lk] = v;
    }
  }

  if (body && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw Object.assign(new Error('请求体过大（>128KB）'), { status: 413 });
  }

  // url 校验
  let origin;
  try {
    origin = originOf(url);
  } catch (err) {
    throw Object.assign(new Error(`url 不合法：${err.message}`), { status: 400 });
  }

  // 白名单校验
  if (!Array.isArray(allow) || !allow.includes(origin)) {
    throw Object.assign(
      new Error(`该插件没有访问 ${origin} 的权限`),
      { status: 403 }
    );
  }

  // 组装 fetch 参数
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...headers
  };

  // [SEC] redirect: 'manual' —— 不让 fetch 自动跟随重定向。
  //   如果上游返回 302 → 别的域名，自动跟随会绕过白名单校验。
  const fetchOpts = { method, headers: reqHeaders, redirect: 'manual' };
  if (body) fetchOpts.body = body;

  return { url, method, body, fetchOpts };
}

// ============================================================
// 一次性完整响应（带缓存）
// ============================================================
/**
 * @param {string} pluginId  发起请求的插件 id（仅用于日志）
 * @param {{url:string, method?:'GET'|'POST', headers?:Object, body?:string|null}} opts
 * @param {string[]} allow   该插件被批准的白名单 origin 列表
 * @returns {Promise<{ status:number, contentType:string, body:string, cached:boolean }>}
 */
async function fetchViaProxy(pluginId, opts, allow) {
  const { url, method, body, fetchOpts } = normalizeRequest(opts, allow);

  // 缓存（只对 GET 生效：POST 通常有副作用，不能无脑复用）
  const ck = cacheKeyOf({ method, url, body });
  if (method === 'GET') {
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
      return { ...hit, cached: true };
    }
  }

  await acquire();
  try {
    const res = await fetch(url, fetchOpts);

    if (res.status >= 300 && res.status < 400) {
      throw Object.assign(new Error(`目标返回重定向 ${res.status}（代理不跟随）`), { status: 502 });
    }

    // [SEC] 响应体上限：防止插件借代理拉一个大文件把内存打爆
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_RESPONSE_BODY_BYTES) {
      throw Object.assign(
        new Error(`响应体过大（${contentLength} 字节，上限 ${MAX_RESPONSE_BODY_BYTES}）`),
        { status: 502 }
      );
    }

    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
      throw Object.assign(
        new Error(`响应体过大（超过 ${MAX_RESPONSE_BODY_BYTES} 字节）`),
        { status: 502 }
      );
    }

    // 写缓存（只缓 GET）
    const entry = { at: Date.now(), status: res.status, contentType, body: bodyText };
    if (method === 'GET') {
      cache.set(ck, entry);
      pruneCache();
    }

    return { ...entry, cached: false };
  } finally {
    release();
  }
}

// ============================================================
// 流式响应（不缓存、不限制响应大小）
// ============================================================
/**
 * 返回上游的原始流，供 SSE / 大响应使用。
 *
 * 与 fetchViaProxy 的区别：
 *   · **不缓存**（流式天然要新的）
 *   · **不限制响应体大小**（调用方按需处理；这是有意的：
 *     有些 API 会用 stream 分块推大内容）
 *   · 调用方负责读取 stream 并在结束时关闭
 *
 * @param {string} pluginId
 * @param {{url:string, method?:'GET'|'POST', headers?:Object, body?:string|null}} opts
 * @param {string[]} allow
 * @returns {Promise<{ status:number, contentType:string, stream:ReadableStream }>}
 */
async function fetchViaProxyStream(pluginId, opts, allow) {
  const { url, fetchOpts } = normalizeRequest(opts, allow);

  // 注意：流式期间会持续占用一个并发槽位，直到调用方读取结束 + stream 关闭。
  // 所以调用方（routes/plugins.js）必须在 `res` 结束时也 `stream.cancel()`。
  await acquire();

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    release();
    throw Object.assign(new Error(`上游请求失败：${err.message}`), { status: 502 });
  }

  if (res.status >= 300 && res.status < 400) {
    release();
    // 上游返回重定向时也要把 body 释放掉，避免 undici 的 socket 泄漏
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw Object.assign(new Error(`目标返回重定向 ${res.status}（代理不跟随）`), { status: 502 });
  }

  if (!res.body) {
    release();
    throw Object.assign(new Error('上游响应不支持流式读取'), { status: 502 });
  }

  const contentType = res.headers.get('content-type') || '';

  // 用 TransformStream 包一层：调用方 cancel 或正常读完时释放并发槽位
  const { ReadableStream } = require('stream/web');
  const originalStream = res.body;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  const wrapped = new ReadableStream({
    start(controller) {
      const reader = originalStream.getReader();
      function pump() {
        reader.read().then(({ value, done }) => {
          if (done) {
            releaseOnce();
            try { controller.close(); } catch { /* ignore */ }
            return;
          }
          try { controller.enqueue(value); } catch { releaseOnce(); return; }
          pump();
        }).catch((err) => {
          releaseOnce();
          try { controller.error(err); } catch { /* ignore */ }
        });
      }
      pump();
    },
    cancel(reason) {
      releaseOnce();
      return originalStream.cancel(reason).catch(() => {});
    }
  });

  return {
    status: res.status,
    contentType,
    stream: wrapped
  };
}

module.exports = {
  fetchViaProxy,
  fetchViaProxyStream,
  // 供测试 / 诊断
  _stats: () => ({ cache: cache.size, running, queued: queue.length })
};