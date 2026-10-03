// src/routes/plugins.js
//
// 插件系统 HTTP 接口。
//
// ============================================================
// 【接口总览】
// ============================================================
//
//   —— 列表 / 详情 / 版本 ——
//   GET    /plugins                       列表（scope=all|installed|mine）
//   GET    /plugins/:id                   详情
//   GET    /plugins/:id/versions          版本历史
//
//   —— 上传 / 发布 / 更新 ——
//   POST   /plugins                       上传 .plugin（multipart）
//   DELETE /plugins/:id                   作者删除自己的插件
//
//   —— 安装 / 分享 / 订阅 / 票据 ——
//   POST   /plugins/:id/install           安装（body: { grantedPerms }）
//   DELETE /plugins/:id/uninstall         卸载
//   POST   /plugins/:id/share             生成 / 重新生成分享码
//   POST   /plugins/:id/private           停止公开
//   POST   /plugins/subscribe             凭分享码订阅
//   POST   /plugins/:id/ticket            申请加载票据（iframe 用）
//   DELETE /plugins/:id/ticket            撤销本用户在本插件下的所有票据
//
//   —— 代理请求（一次性） ——
//   POST   /plugins/:id/proxy             代理 GET/POST（带服务端缓存）
//
//   —— 代理请求（流式） ——
//   POST   /plugins/:id/proxy/stream      代理 GET/POST（透传上游流，不缓存）
//
//   —— 加载通道（iframe 用） ——
//   GET    /plugins/:id/entry             默认入口页（manifest.pages[0]）
//   GET    /plugins/:id/p/:ticket/*       页面通道（多页面路由的核心）
//   GET    /plugins/:id/a/:ticket/*       资源通道（CSS/JS/图片/字体…）
//   GET    /plugins/:id/asset             兼容旧路径（query 形式）
//
//   —— KV 存储 ——
//   GET    /plugins/:id/kv                KV 全量 + 用量
//   POST   /plugins/:id/kv                写 KV
//   DELETE /plugins/:id/kv/:key           删 KV
//
//   —— 管理接口 ——
//   GET    /admin/plugins                 全量列表（含 hidden / delisted）
//   GET    /admin/plugins/stats           总览统计
//   GET    /admin/plugins/whitelist       查看当前 proxy 白名单
//   POST   /admin/plugins/:id/delist      下架
//   POST   /admin/plugins/:id/hide        隐藏（软下架）
//   POST   /admin/plugins/:id/restore     恢复
//
// ============================================================
// 【本次改动 · 多页面路由】
// ============================================================
//   · 新增 GET /plugins/:id/p/:ticket/*  —— **页面通道**
//     与 /a/:ticket/* 的区别：
//       - /a/ 返回资源文件（CSS/JS/图片），**不注入任何东西**
//       - /p/ 返回页面 HTML，**注入 base + title + 桥脚本**
//     页面路径必须在 manifest.pages 里（在 service 层校验）。
//   · GET /plugins/:id/entry 改用 buildEntryHtml（注入 base + 桥）
//   · 三个通道共用一个 setPluginContentHeaders(req, res) 来设置安全头
//
// ============================================================
// 【本次改动 · CSP 动态 origin】
// ============================================================
//   多文件插件必须能加载自身资源（<link href="lib/x.css"> 之类的相对路径）。
//   但 iframe 是 sandbox="allow-scripts" **不给** allow-same-origin，
//   文档源是 "null"（不透明）—— CSP 里的 'self' 在这种环境下不匹配任何 URL，
//   导致所有 <script src> / <link href> 都被拦。
//
//   修法：把当前请求的 origin（protocol + host）显式加进 CSP 白名单。
//   安全性不受影响：
//     · connect-src 'none'   —— 插件仍无法直接发起 fetch
//     · frame-ancestors 'self' —— 宿主之外的页面不能嵌套它
//     · sandbox 不给 allow-same-origin —— 拿不到宿主 cookie/localStorage
//   放行自己 origin 的静态资源不改变以上任何一条。
//
// ============================================================
// 【上一轮改动 · 版本历史】
// ============================================================
//   · POST /plugins 接收 changelog 字段，写进 plugin_versions
//   · GET /plugins/:id/versions 返回版本列表
//
// ============================================================
// 【历史修复】
// ============================================================
//   · uploadPlugin 的文件名随机段用 CSPRNG（crypto.randomBytes）
//   · 移除从未使用的 audit import
//   · 代理请求头白名单（authorization/content-type/accept/x-api-key）
//   · 代理请求体上限 128KB
//   · 流式代理：req.on('close') 同步取消上游
// ============================================================
//
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const { authMiddleware } = require('../auth');
const pluginsSvc = require('../services/plugins');
const pluginProxy = require('../services/pluginProxy');
const pluginWhitelist = require('../services/pluginWhitelist');
const tickets = require('../services/pluginTickets');
const entryBuilder = require('../services/pluginBridgeSource');
const { can } = require('../services/permissions');

const router = express.Router();
const CFG = config.PLUGIN_CFG;

// ============================================================
// 上传中间件
// ============================================================
const uploadPlugin = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.TMP_DIR),
    filename: (req, file, cb) => {
      // [SEC] 与 middleware/upload.js 的其它上传中间件口径一致：
      //   用 CSPRNG 生成随机段，避免 Math.random() 约 41bit 的可预测性。
      const rand = crypto.randomBytes(6).toString('hex');
      cb(null, `plugin_${Date.now()}_${rand}.plugin`);
    }
  }),
  limits: { fileSize: CFG.max_bundle_bytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.plugin')) {
      return cb(new Error('插件包必须以 .plugin 结尾'));
    }
    cb(null, true);
  }
});

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

function sendErr(res, err) {
  res.status(err.status || 400).json({ error: err.message || '操作失败' });
}

// ============================================================
// 代理请求的入参规范化（/proxy 与 /proxy/stream 共用）
// ============================================================

// 允许插件通过代理转发的请求头白名单。
// 与 client/src/utils/pluginBridge.js 的同名白名单是**双层过滤** ——
// 客户端先过滤一遍（防止把无意义的头带上），服务端再过滤一遍
// （防止客户端被绕过）。两边的白名单内容必须一致。
const ALLOWED_PROXY_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key']);

// 单次请求体上限（UTF-8 字节数）
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

/**
 * 从 req.body 里提取 { url, method, headers, body }。
 * 所有字段都做白名单过滤 + 长度检查。
 *
 * @throws {Error & { status: number }}
 */
function parseProxyBody(req) {
  const url = String(req.body?.url || '').trim();
  if (!url) throw Object.assign(new Error('缺少 url'), { status: 400 });

  // method 只放行 GET / POST（其它一律降级为 GET）
  const method = String(req.body?.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';

  // 请求头白名单
  const headers = {};
  const rawHeaders = req.body?.headers;
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders)) {
      const lk = String(k).toLowerCase();
      if (!ALLOWED_PROXY_HEADERS.has(lk)) continue;
      if (typeof v !== 'string') continue;
      headers[lk] = v.slice(0, 2000);
    }
  }

  // 请求体（仅 POST 允许；长度有硬上限）
  let body = null;
  if (method === 'POST' && req.body?.body !== undefined && req.body?.body !== null) {
    const b = typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body);
    if (Buffer.byteLength(b, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大（>128KB）'), { status: 413 });
    }
    body = b;
  }

  return { url, method, headers, body };
}

/**
 * 代理请求的权限链（/proxy 与 /proxy/stream 共用）：
 *   1) 插件存在、状态 active
 *   2) 用户已安装（或就是作者）
 *   3) 白名单非空（从 plugin-whitelist.yaml 读）
 *
 * @returns {{pluginId: string, allow: string[]}}
 */
function assertProxyAllowed(req) {
  const pluginId = String(req.params.id);
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row) throw Object.assign(new Error('插件不存在'), { status: 404 });
  if (row.status !== 'active') {
    throw Object.assign(new Error('插件已下架'), { status: 403 });
  }

  const installed = pluginsSvc.isInstalled(req.user.id, pluginId);
  if (!installed && row.owner_id !== req.user.id) {
    throw Object.assign(new Error('未安装该插件'), { status: 403 });
  }

  const allow = pluginWhitelist.getAllowList(pluginId);
  if (allow.length === 0) {
    throw Object.assign(
      new Error(`该插件未配置 proxy 白名单（请在 server/plugin-whitelist.yaml 里添加 ${pluginId}: [...]）`),
      { status: 403 }
    );
  }

  return { pluginId, allow };
}

// ============================================================
// 列表 / 详情
// ============================================================
router.get('/plugins', authMiddleware, (req, res) => {
  try {
    const scope = String(req.query.scope || 'all');
    const keyword = String(req.query.keyword || '');
    res.json({ plugins: pluginsSvc.listAll(req.user.id, { scope, keyword }) });
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/plugins/:id', authMiddleware, (req, res) => {
  try {
    const dto = pluginsSvc.getById(String(req.params.id), req.user.id);
    if (!dto) return res.status(404).json({ error: '插件不存在' });
    if (!dto.installed && !dto.isOwner && !dto.isPublic) {
      return res.status(403).json({ error: '无权查看该插件' });
    }
    res.json({ plugin: dto });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 版本历史
//
// 返回当前版本 + 归档历史（按上传时间倒序）。
// 归档由 services/plugins.js::publish 在覆盖旧版本时写入。
// ============================================================
router.get('/plugins/:id/versions', authMiddleware, (req, res) => {
  try {
    const dto = pluginsSvc.getById(String(req.params.id), req.user.id);
    if (!dto) return res.status(404).json({ error: '插件不存在' });
    if (!dto.installed && !dto.isOwner && !dto.isPublic) {
      return res.status(403).json({ error: '无权查看该插件' });
    }
    res.json({
      currentVersion: dto.version,
      versions: pluginsSvc.listVersions(String(req.params.id))
    });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 上传 / 发布 / 更新
//
// 上传的是打包后的 .plugin（JSON 格式：{ manifest, files }）。
// 支持多文件项目 —— files 里可以有任意子目录（pages/、lib/、assets/…）。
// manifest.pages 里列的每个页面路径都必须在 files 里存在。
// ============================================================
router.post('/plugins', authMiddleware, (req, res) => {
  uploadPlugin.single('bundle')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `插件包不能超过 ${Math.round(CFG.max_bundle_bytes / 1048576)}MB`
        });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到插件包' });

    try {
      const buf = fs.readFileSync(req.file.path);
      const isPublic = req.body?.isPublic === '1' || req.body?.isPublic === true;
      const changelog = String(req.body?.changelog || '').slice(0, 2000);

      const dto = pluginsSvc.publish({
        ownerId: req.user.id,
        buf,
        isPublic,
        iconUrl: req.body?.iconUrl || null,
        changelog
      });
      res.json({ ok: true, plugin: dto });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message || '发布失败' });
    } finally {
      // 无论成败都清理临时文件
      safeUnlink(req.file.path);
    }
  });
});

// ============================================================
// 代理请求（一次性，带缓存）
//
// 权限链见 assertProxyAllowed。
// 目标 url 的 origin 必须在白名单里（service 层再校验一次）。
// ============================================================
router.post('/plugins/:id/proxy', authMiddleware, async (req, res) => {
  try {
    const { pluginId, allow } = assertProxyAllowed(req);
    const opts = parseProxyBody(req);
    const result = await pluginProxy.fetchViaProxy(pluginId, opts, allow);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 代理请求（流式，不缓存）
//
// 与 /proxy 的区别：
//   · **不缓存**（流式天然要新的）
//   · **不限制响应体大小**（调用方按需处理；有些 API 会用 stream 分块推大内容）
//   · **边读边转发**到客户端（HTTP chunked），上游返回 text/event-stream
//     时客户端能实时收到每一块
//   · 客户端断开时同步取消上游请求（避免连接泄漏 + 释放并发槽位）
//
// 前端通过 client/src/utils/pluginBridge.js 的 'proxy.stream.start' handler
// 消费；该 handler 会再逐块 postMessage 给插件 iframe。
// ============================================================
router.post('/plugins/:id/proxy/stream', authMiddleware, async (req, res) => {
  let nodeStream = null;
  try {
    const { pluginId, allow } = assertProxyAllowed(req);
    const opts = parseProxyBody(req);

    const result = await pluginProxy.fetchViaProxyStream(pluginId, opts, allow);

    // 把上游流 pipe 到本次响应
    res.status(result.status);
    res.setHeader('Content-Type', result.contentType || 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 若未来通过 nginx 反代，明确告诉它不要缓冲流式响应
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Node 18+ 的 fetch 返回 web ReadableStream；用 Readable.fromWeb 转成
    // Node 流后 pipe 到 Express 响应。这样 Node 会自动处理 backpressure。
    nodeStream = Readable.fromWeb(result.stream);

    // 客户端提前断开时，同步取消上游（否则并发槽位不释放）
    const onClose = () => {
      try { nodeStream.destroy(); } catch { /* ignore */ }
    };
    req.on('close', onClose);

    nodeStream.on('error', (err) => {
      console.error('[plugin proxy stream]', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: '上游流中断' });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
    nodeStream.on('end', () => {
      req.off('close', onClose);
    });

    nodeStream.pipe(res);
  } catch (err) {
    // 到这里通常还没发过 header（首个数据块到来前抛错）
    if (!res.headersSent) {
      sendErr(res, err);
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

// ============================================================
// 安装 / 卸载
// ============================================================
router.post('/plugins/:id/install', authMiddleware, (req, res) => {
  try {
    const grantedPerms = Array.isArray(req.body?.grantedPerms) ? req.body.grantedPerms : [];
    const dto = pluginsSvc.install(req.user.id, String(req.params.id), grantedPerms);
    res.json({ ok: true, plugin: dto });
  } catch (err) {
    sendErr(res, err);
  }
});

router.delete('/plugins/:id/uninstall', authMiddleware, (req, res) => {
  try {
    pluginsSvc.uninstall(req.user.id, String(req.params.id));
    // 卸载时顺手作废本用户在本插件下的所有票据
    tickets.revokeAll(req.user.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 分享 / 订阅
// ============================================================
router.post('/plugins/:id/share', authMiddleware, (req, res) => {
  try {
    const out = pluginsSvc.share(req.user.id, String(req.params.id), !!req.body?.regenerate);
    res.json({ ok: true, ...out });
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/plugins/:id/private', authMiddleware, (req, res) => {
  try {
    const dto = pluginsSvc.setPrivate(req.user.id, String(req.params.id));
    res.json({ ok: true, plugin: dto });
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/plugins/subscribe', authMiddleware, (req, res) => {
  try {
    const dto = pluginsSvc.subscribe(req.user.id, req.body?.code ?? req.body?.shareCode);
    res.json({ ok: true, plugin: dto });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 票据
//
// 票据用于 iframe 里那些**无法携带 Authorization 头**的请求：
// <script src> / <link href> / <img src> / <iframe src>。
// 见 server/src/services/pluginTickets.js。
// ============================================================
router.post('/plugins/:id/ticket', authMiddleware, (req, res) => {
  try {
    const pluginId = String(req.params.id);
    // 先校验一次 —— 未安装 / 已下架的插件不应签发票据
    pluginsSvc.resolveEntry(req.user.id, pluginId);
    const out = tickets.issue(req.user.id, pluginId);
    res.json(out);
  } catch (err) {
    sendErr(res, err);
  }
});

router.delete('/plugins/:id/ticket', authMiddleware, (req, res) => {
  try {
    tickets.revokeAll(req.user.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 加载鉴权（供 /entry、/asset 使用；/p 和 /a 用 ticket 路径段）
//
// 两种方式：
//   1) query ?t=<ticket>   —— 传统方式，兼容旧调用
//   2) Authorization 头    —— 作者在浏览器直接访问调试时用
// ============================================================
function pluginLoadAuth(req, res, next) {
  const t = String(req.query.t || '');
  const pluginId = String(req.params.id);
  if (t) {
    const rec = tickets.verify(t, pluginId);
    if (!rec) {
      return res.status(401).json({ error: '票据无效或过期' });
    }
    req.user = { id: rec.userId };
    req.pluginTicket = { userId: rec.userId, pluginId: rec.pluginId };
    return next();
  }
  return authMiddleware(req, res, next);
}

// ============================================================
// 统一的安全响应头
//
// [FIX] **动态 CSP** —— 把当前请求的 origin 加进白名单。
//
//   为什么必须这样做：
//     iframe 是 sandbox="allow-scripts" **不给** allow-same-origin，
//     文档源是 "null"（不透明源）。在它下面 CSP 的 'self' 不匹配任何 URL，
//     导致多文件插件里的 `<script src="lib/host.js">`（浏览器展开为
//     http://host/api/plugins/.../lib/host.js）被拦。
//
//   安全性不受影响：
//     · connect-src 'none'      —— 插件仍无法直接 fetch
//     · frame-ancestors 'self'  —— 宿主之外的页面不能嵌套
//     · sandbox 不给 same-origin —— 拿不到宿主 cookie/localStorage
//     · 浏览器 CORS 内核限制    —— 即使放宽 CSP 也拦不住跨源 fetch
//   放行自己 origin 的静态资源不影响以上任何一条。
//
//   兼容性：
//     · 反代场景下 req.protocol 由 trust proxy 决定
//     · Host 头是客户端给的，但伪造 Host 只会得到一个「允许了错误 origin」
//       的 CSP —— 攻击者拿不到什么好处（他本来就能控制自己的 Host）
//     · 没拿到 host 时退回只用 'self'（老行为，单文件插件仍可用）
// ============================================================
function setPluginContentHeaders(req, res) {
  const proto = (req && req.protocol) || 'http';
  const hostHeader = req && req.headers && req.headers.host;
  const origin = hostHeader ? `${proto}://${hostHeader}` : '';

  // 白名单词
  const allow = ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:'];
  if (origin) allow.push(origin);
  const joined = allow.join(' ');

  const csp = [
    `default-src ${joined}`,
    `script-src ${joined}`,
    `style-src ${joined}`,
    `img-src ${joined}`,
    `media-src ${joined}`,
    `font-src ${joined}`,
    // [SEC] 插件不能直接发起网络请求；要走网络必须通过代理通道
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    // base 指向服务器路径 → 允许当前 origin 作为 base-uri
    origin ? `base-uri 'self' ${origin}` : "base-uri 'self'"
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

// ============================================================
// 入口 HTML（默认打开 manifest.pages[0]）
//
// 兼容通道：
//   前端如果直接访问 /entry?t=<ticket>，走这里。
//   但多页面路由项目应该用 /p/:ticket/<pagePath> 形式。
//
// 逻辑：
//   1) 校验安装状态（resolveEntry 内部做）
//   2) 读 manifest.pages[0] 的 title
//   3) 调 buildEntryHtml 注入 <base> + <title> + 桥脚本
//   4) 设置安全头（含动态 CSP）
// ============================================================
router.get('/plugins/:id/entry', pluginLoadAuth, (req, res) => {
  try {
    const pluginId = String(req.params.id);
    const abs = pluginsSvc.resolveEntry(req.user.id, pluginId);
    const rawHtml = fs.readFileSync(abs, 'utf8');

    // 拿到 ticket：优先用 query 参数，否则现申请一张（供 base 使用）
    let ticket = String(req.query.t || '');
    if (!ticket) {
      const issued = tickets.issue(req.user.id, pluginId);
      ticket = issued.ticket;
    }

    // 从 manifest 里找 pages[0] 的 title
    const plugin = pluginsSvc.getById(pluginId, req.user.id);
    const firstPage = plugin?.pages?.[0];
    const pageTitle = firstPage?.title || '';

    const html = entryBuilder.buildEntryHtml(rawHtml, { pluginId, ticket, pageTitle });
    setPluginContentHeaders(req, res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// [NEW] 页面通道（多页面路由的核心）
//
// 路径：/plugins/:id/p/:ticket/<pagePath>[?__params=<json>]
//
//   · 返回页面 HTML（注入 base + title + 桥脚本）
//   · pagePath 必须出现在 manifest.pages 里（在这里校验）
//   · __params 是宿主传给页面的入参 —— 桥脚本的 getLaunchParams() 会解析它
//   · <base> 仍指向 /a/:ticket/（资源通道），因此页面里的相对资源
//     引用要用**从资源根算的路径**（例如 `pages/chat/index.css`）
//
// 为什么 ticket 在**路径段**里（不是 query）：
//   <base href=".../a/<ticket>/"> 之后，`<script src="lib/x.js">`
//   会被浏览器解析为 `.../a/<ticket>/lib/x.js` —— ticket 必须在路径里。
//   这是浏览器对 <base> 的既定行为，无法改成 query。
// ============================================================
router.get('/plugins/:id/p/:ticket/*', (req, res) => {
  const pluginId = String(req.params.id);
  const ticket = String(req.params.ticket);
  const pagePath = String(req.params[0] || '').trim();
  if (!pagePath) return res.status(400).json({ error: '缺少页面路径' });

  const rec = tickets.verify(ticket, pluginId);
  if (!rec) return res.status(401).json({ error: '票据无效或过期' });

  try {
    const plugin = pluginsSvc.getById(pluginId, rec.userId);
    if (!plugin) return res.status(404).json({ error: '插件不存在' });

    // 校验 pagePath 在 manifest.pages 里
    const pages = Array.isArray(plugin.pages) && plugin.pages.length > 0
      ? plugin.pages
      : [{ path: plugin.entry, title: '' }];
    const pageDef = pages.find((p) => p.path === pagePath);
    if (!pageDef) {
      return res.status(404).json({ error: `页面不在 manifest.pages 里：${pagePath}` });
    }

    // resolveAsset 会做存在性、越界检查（与 /a/ 通道共享）
    const abs = pluginsSvc.resolveAsset(rec.userId, pluginId, pagePath);
    const rawHtml = fs.readFileSync(abs, 'utf8');
    const html = entryBuilder.buildEntryHtml(rawHtml, {
      pluginId,
      ticket,
      pageTitle: pageDef.title || ''
    });
    setPluginContentHeaders(req, res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 资源通道（多文件项目的核心）
//
// 路径：/plugins/:id/a/:ticket/<relPath>
//
//   · 返回**原始文件内容**（CSS/JS/图片/字体/…）
//   · **不注入任何东西**
//   · relPath 是**从资源根算的路径**（例如 `pages/chat/index.css`）
//   · ticket 校验后走 resolveAsset（内部再次做用户身份 + 存在性 + 越界检查）
//
// 缓存策略：
//   同一 ticket 内多次请求同一文件无副作用 → private, max-age=300
//   注意不是 immutable（同一个 URL 在票据过期后会失效，不能永久缓存）
// ============================================================
router.get('/plugins/:id/a/:ticket/*', (req, res) => {
  const pluginId = String(req.params.id);
  const ticket = String(req.params.ticket);
  const relPath = String(req.params[0] || '').trim();

  const rec = tickets.verify(ticket, pluginId);
  if (!rec) return res.status(401).json({ error: '票据无效或过期' });

  if (!relPath) return res.status(400).json({ error: '缺少资源路径' });

  try {
    const abs = pluginsSvc.resolveAsset(rec.userId, pluginId, relPath);
    setPluginContentHeaders(req, res);
    res.setHeader('Content-Type', pluginsSvc.mimeOf(abs));
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 兼容旧路径：/plugins/:id/asset?t=&path=
//
// 早期接口，前端旧代码可能仍在使用。
// 新代码请走 /a/:ticket/*（路径形式）—— 它会被 <base> 自然拼接。
// ============================================================
router.get('/plugins/:id/asset', pluginLoadAuth, (req, res) => {
  const rel = String(req.query.path || '');
  try {
    const abs = pluginsSvc.resolveAsset(req.user.id, String(req.params.id), rel);
    setPluginContentHeaders(req, res);
    res.setHeader('Content-Type', pluginsSvc.mimeOf(abs));
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// KV 存储
//
// 每个 (插件 × 用户) 一份隔离空间。
// 读写都要经过「已安装 or 作者」+「storage 权限」双重检查。
// 配额由 config.yaml → plugins.kv_quota_bytes 决定（默认 100KB）。
// ============================================================

/** 断言：用户已安装此插件（作者豁免） */
function assertInstalledOrOwner(userId, pluginId) {
  const row = db.prepare('SELECT owner_id, status FROM plugins WHERE id = ?').get(pluginId);
  if (!row) { const e = new Error('插件不存在'); e.status = 404; throw e; }
  if (row.status !== 'active') { const e = new Error('插件已下架'); e.status = 403; throw e; }
  const installed = pluginsSvc.isInstalled(userId, pluginId);
  if (!installed && row.owner_id !== userId) {
    const e = new Error('未安装该插件'); e.status = 403; throw e;
  }
  return row;
}

/** 断言：用户已批准指定权限（作者豁免） */
function requirePerm(userId, pluginId, perm) {
  const row = db.prepare('SELECT owner_id FROM plugins WHERE id = ?').get(pluginId);
  if (row && row.owner_id === userId) return true;
  const set = pluginsSvc.grantedPermSet(userId, pluginId);
  if (!set.has(perm)) {
    const e = new Error(`缺少权限：${perm}`); e.status = 403; throw e;
  }
  return true;
}

router.get('/plugins/:id/kv', authMiddleware, (req, res) => {
  try {
    assertInstalledOrOwner(req.user.id, String(req.params.id));
    requirePerm(req.user.id, String(req.params.id), 'storage');
    res.json({
      items: pluginsSvc.kvList(String(req.params.id), req.user.id),
      usage: pluginsSvc.kvUsage(String(req.params.id), req.user.id)
    });
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/plugins/:id/kv', authMiddleware, (req, res) => {
  try {
    assertInstalledOrOwner(req.user.id, String(req.params.id));
    requirePerm(req.user.id, String(req.params.id), 'storage');
    const { key, value } = req.body || {};
    const out = pluginsSvc.kvSet(String(req.params.id), req.user.id, key, value);
    res.json({
      ok: true,
      item: out,
      usage: pluginsSvc.kvUsage(String(req.params.id), req.user.id)
    });
  } catch (err) {
    sendErr(res, err);
  }
});

router.delete('/plugins/:id/kv/:key', authMiddleware, (req, res) => {
  try {
    assertInstalledOrOwner(req.user.id, String(req.params.id));
    requirePerm(req.user.id, String(req.params.id), 'storage');
    pluginsSvc.kvDel(String(req.params.id), req.user.id, String(req.params.key));
    res.json({
      ok: true,
      usage: pluginsSvc.kvUsage(String(req.params.id), req.user.id)
    });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 管理接口
//
// 权限位：
//   review_plugin  —— 查看全量列表 / 统计 / 白名单
//   delist_plugin  —— 下架 / 隐藏 / 恢复
// ============================================================
function requireCap(capability) {
  return (req, res, next) => {
    if (!can(req.user.role, capability)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

// 全量列表（含 hidden / delisted）
router.get('/admin/plugins', authMiddleware, requireCap('review_plugin'), (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const keyword = String(req.query.keyword || '');
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : null;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // 只允许列出的状态值，避免注入奇怪字符
    const allowedStatus = ['active', 'hidden', 'delisted'];
    const st = status && allowedStatus.includes(status) ? status : null;

    res.json({
      plugins: pluginsSvc.listForAdmin({ status: st, keyword, ownerId, limit, offset })
    });
  } catch (err) {
    sendErr(res, err);
  }
});

// 总览统计
router.get('/admin/plugins/stats', authMiddleware, requireCap('review_plugin'), (req, res) => {
  try {
    res.json(pluginsSvc.adminStats());
  } catch (err) {
    sendErr(res, err);
  }
});

// 查看当前 proxy 白名单（含热重载源文件路径）
router.get('/admin/plugins/whitelist', authMiddleware, requireCap('review_plugin'), (req, res) => {
  try {
    // 强制拉一次以保证返回最新；all() 内部会检测 mtime
    const data = pluginWhitelist.all();
    res.json({
      whitelist: data,
      count: Object.keys(data).length,
      source: pluginWhitelist.FILE,
      maxHostsPerPlugin: pluginWhitelist.MAX_HOSTS
    });
  } catch (err) {
    sendErr(res, err);
  }
});

// 下架（作者重新上传同 id 包不会复活，需管理员 restore）
router.post('/admin/plugins/:id/delist', authMiddleware, requireCap('delist_plugin'), (req, res) => {
  try {
    const reason = String(req.body?.reason || '').slice(0, 500);
    pluginsSvc.delist(String(req.params.id), req.user.id, req.user.role, reason);
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

// 隐藏（软下架，不影响已有安装）
router.post('/admin/plugins/:id/hide', authMiddleware, requireCap('delist_plugin'), (req, res) => {
  try {
    const reason = String(req.body?.reason || '').slice(0, 500);
    pluginsSvc.hide(String(req.params.id), req.user.id, req.user.role, reason);
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

// 恢复（hidden / delisted → active）
router.post('/admin/plugins/:id/restore', authMiddleware, requireCap('delist_plugin'), (req, res) => {
  try {
    pluginsSvc.restore(String(req.params.id), req.user.id, req.user.role);
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

// ============================================================
// 作者：删除自己的插件
//
// 同时清理：
//   · user_plugins（所有用户的安装关系）
//   · plugin_kv（所有用户的 KV）
//   · plugin_versions（版本历史表）
//   · uploads/plugins/<id>/（当前版本目录）
//   · uploads/plugins/.history/<id>/（历史归档目录）
// ============================================================
router.delete('/plugins/:id', authMiddleware, (req, res) => {
  try {
    pluginsSvc.removeById(req.user.id, String(req.params.id));
    tickets.revokeAll(req.user.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;