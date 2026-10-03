// index.js
const http = require('http');
const config = require('./src/config');
const app = require('./src/app');
const setupSocket = require('./src/socket');
// 【新增】支付系统的过期扫描（转账 / 红包）
const paymentsExpiry = require('./src/services/payments_expiry');
// [NEW] 双 token 认证的 Refresh Token 清理
const refreshTokens = require('./src/services/refreshTokens');

const server = http.createServer(app);
const { io, getOnlineCount } = setupSocket(server);

// 健康检查（在 socket 初始化之后注册，能拿到 online 数）
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    online: getOnlineCount(),
    uptime: Math.round(process.uptime()),
    now: Date.now()
  });
});

// [SEC] 显式绑定 config.HOST（默认 127.0.0.1）。
//   只写 server.listen(port) 时 Node 会绑 0.0.0.0，同一网段任何主机都能
//   绕开 Vite 代理直连后端（接管真实报错、绕过代理层限制）。
//   要对外提供 API 请显式改 config.yaml → server.host。
server.listen(config.PORT, config.HOST, () => {
  console.log(`服务器运行在 http://${config.HOST}:${config.PORT}`);
  // 支付系统过期扫描（进程内定时器，unref 不阻塞退出）
  paymentsExpiry.start();
  console.log('[payments] 过期扫描已启动（每分钟一次）');

  // [NEW] Refresh Token 定期清理：删掉过期 30 天以上的行
  //   （会话本身在刷新时已撤销，这里只是把陈旧记录从库里清走，便于审计）
  const rtPruneTimer = setInterval(() => {
    try {
      const n = refreshTokens.pruneExpired();
      if (n > 0) console.log(`[auth] 清理过期 Refresh Token：${n} 行`);
    } catch (err) {
      console.error('[auth] 清理 Refresh Token 失败：', err);
    }
  }, 6 * 3600 * 1000);
  if (typeof rtPruneTimer.unref === 'function') rtPruneTimer.unref();
  console.log('[auth] Refresh Token 清理已启动（每 6 小时一次）');
});