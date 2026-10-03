// src/app.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');

require('./db');                 // 初始化 DB（建表 + seed）
require('./middleware/upload');  // 确保上传目录存在

const routes = require('./routes');
const { requireApiKey } = require('./auth');

const app = express();

// [SEC] 默认不信任 X-Forwarded-For：直连时 req.ip = TCP 对端地址，
//       客户端无法用伪造的转发头绕过 IP 绑定 / 失败次数上限。
//       部署在 nginx 等反向代理之后时，把 config.yaml 的
//       security.trust_proxy 设为 true（只信任 1 跳）。
app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

app.use(express.json({ limit: '1mb' }));

// [NEW] 轻量 Cookie 解析：把解析结果挂到 req.cookies，供刷新端点读取。
//   不引入 cookie-parser 依赖 —— 项目风格是零依赖优先，需要的功能就这一件。
//   见 auth/cookies.js（parseCookies / setRefreshCookie / clearRefreshCookie）。
{
  const { parseCookies } = require('./auth/cookies');
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie || '');
    next();
  });
}

// [SEC] 全局安全响应头：API 响应统一 nosniff / 不被 iframe / 不外泄 Referrer。
//   静态上传目录已有自己的 CSP + nosniff（见下），这里是 API 与 SPA 的兜底。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ============================================================
// 静态目录
//
// [SEC] 只暴露 config.static.expose 里列出的目录。
//       默认 avatars / files / covers / custom。
//       shop 不暴露 —— 商品文件必须走 /api/shop/download 鉴权。
//       custom 是用户资源池（聊天背景 / 气泡素材 / 表情图片），
//       聊天里对端必须能直接取到，所以对外只读暴露。
// ============================================================
const STATIC_SUBDIRS = config.STATIC_EXPOSE;

for (const sub of STATIC_SUBDIRS) {
  app.use(
    `/uploads/${sub}`,
    express.static(path.join(config.UPLOAD_ROOT, sub), {
      setHeaders(res, filePath) {
        const dangerous = /\.(html?|xhtml|svg|xml|js|mjs|cjs|css)$/i.test(filePath);
        if (dangerous) {
          res.setHeader('Content-Disposition', 'attachment');
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
    })
  );
}

// ============================================================
// API
//
//   /api/*      —— 主通道：JWT（浏览器）或 API 密钥（脚本）都接受
//   /api/v1/*   —— 第二认证通道：只认 API 密钥，独立按密钥限流
//
// 两条路径挂同一套路由，所以「现有受 JWT 保护的接口」脚本带密钥
// 都能等价调用，同时又有独立的 /api/v1 前缀。
// ============================================================
app.use('/api', routes);
app.use('/api/v1', requireApiKey, routes);

// ============================================================
// API 兜底：未匹配到的 /api/* 统一返回 JSON 404
//
// [NOTE] 只挂在 /api 下，不要加全局 catch-all —— index.js 会在本文件
//        之后注册 /health，全局兜底会把 /health 也一起吃掉。
// ============================================================
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在', path: req.originalUrl });
});

// ============================================================
// 前端静态托管（单端口部署 / 局域网共享）
//
//   client 里 `npm run build` 之后，浏览器直接打开 http://<本机IP>:3001/
//   就是完整应用：页面、API、socket.io、上传文件全在**同一个源**上 ——
//   没有反代、没有 CORS、也没有 dev server 那种「源码 + source map 一起
//   发出去」的泄露面（外部渗透报告 F-01）。
//
//   挂载顺序是这里唯一容易出错的地方：
//     · 必须在 /api 路由与 /api 的 JSON 404 **之后** —— 否则接口会被
//       index.html 吃掉（前端会收到一坨 HTML 而不是 JSON）；
//     · /uploads 未命中时必须继续 404，**不能**回落到 index.html
//       （那是「文件不存在」，不是前端路由）；
//     · /health 由 index.js 在本文件**之后**注册（它要拿 socket 在线数），
//       这里必须显式排除，否则会把健康检查一起吞掉（§1.24 的老坑）。
// ============================================================
if (config.SERVE_CLIENT) {
  const dist = config.CLIENT_DIST;
  const indexHtml = path.join(dist, 'index.html');

  if (fs.existsSync(indexHtml)) {
    // 带内容 hash 的产物可以长缓存；index.html 本身不进这个分支（下面统一走 fallback）
    app.use('/assets', express.static(path.join(dist, 'assets'), {
      index: false, immutable: true, maxAge: '1y'
    }));
    // 其余静态文件：logo.jpg、favicon 等
    app.use(express.static(dist, { index: false }));

    const SPA_SKIP = /^\/(?:api|uploads|socket\.io|health)(?:\/|$)/;
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (SPA_SKIP.test(req.path)) return next();
      // 只要浏览器「想要网页」就回 SPA 外壳（自写视图路由全靠这一条）
      if (!req.accepts('html')) return next();
      res.sendFile(indexHtml);
    });

    console.log(`[static] 前端已托管：${dist}`);
  } else if (fs.existsSync(path.dirname(dist))) {
    console.log(`[static] 跳过前端托管：${indexHtml} 不存在（先在 client 目录执行 npm run build）`);
  }
}

// ============================================================
// 全局错误处理：保证任何未捕获异常都以 JSON 返回，
// 而不是 Express 默认的 HTML 堆栈页（避免把服务器细节泄漏给客户端）。
// ============================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err?.status) || Number(err?.statusCode) || 500;

  // multer 的体积 / 数量限制在这里统一兜底（各路由已各自处理，这里是最后一道）
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件超过大小限制' });
  }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: '上传文件数量或字段不合法' });
  }

  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);

  res.status(status).json({
    error: status >= 500 ? '服务器内部错误' : (err?.message || '请求失败')
  });
});

module.exports = app;