// src/utils/ip.js
//
// 客户端 IP 归一化。用于 API 密钥的 IP 绑定（apikey_ip_claims）、
// 按 IP 的失败次数上限、以及下载审计日志。
//
// [SEC] 取值来源必须可信：X-Forwarded-For / X-Real-IP 都是**客户端可自行伪造**
//       的请求头。直连部署时若直接采信，攻击者只要轮换这个头就能：
//         · 绕过「同一 IP 只能绑定一个用户」（apikey_ip_claims）
//         · 绕过「按 IP 的失败次数上限」（apikey.ipFailures）→ 无限暴力枚举密钥
//         · 污染下载审计日志
//       因此默认只认 TCP 对端地址；只有在反向代理之后
//       （security.trust_proxy: true）才交给 Express 的 trust proxy 解析。
//
const config = require('../config');

function normalizeIp(raw) {
  let ip = (raw || '').toString().trim();
  if (!ip) return 'unknown';
  // IPv4-mapped IPv6：::ffff:1.2.3.4 → 1.2.3.4
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  // [::1]:1234 → ::1
  const m = ip.match(/^\[(.+)\](?::\d+)?$/);
  if (m) ip = m[1];
  if (ip.length > 64) ip = ip.slice(0, 64);
  return ip || 'unknown';
}

/**
 * 请求来源 IP。
 *
 * Express 的 req.ip 会依据 app.set('trust proxy', ...) 决定是否采信
 * X-Forwarded-For：未信任代理时它等于 TCP 对端地址，信任时才是转发链上的真实客户端。
 * 所以这里统一用 req.ip（app.js 已按 config.TRUST_PROXY 设置好），
 * socket 握手等没有 req.ip 的场景再回落到 remoteAddress。
 *
 * [SEC] 千万不要自己去取 `X-Forwarded-For` 的**第一段**：那是客户端可以随便写的。
 *       反代（Vite 的 xfwd / nginx 的 proxy_set_header）是把真实对端**追加到末尾**，
 *       所以「1.2.3.4, <真实IP>」里第一段是伪造值、最后一段才可信。
 *       Express 的 trust proxy 已按「跳过 N 跳可信代理、从右往左找」算好了 req.ip，
 *       直接用即可；只有 socket 握手这种没有 req.ip 的伪造 req 才需要手工从右取。
 */
function clientIp(req) {
  // 1) 正常的 Express 请求：req.ip 已经由 trust proxy 按配置解析过，直接用
  if (typeof req?.ip === 'string' && req.ip) return normalizeIp(req.ip);

  // 2) 手工构造的 req（socket 握手）：没有 req.ip，只能自己解析 XFF，
  //    此时取**最后一段**（最近一跳可信代理写入的真实对端）
  if (config.TRUST_PROXY) {
    const parts = (req?.headers?.['x-forwarded-for'] || '')
      .toString().split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[parts.length - 1]);
  }

  return normalizeIp(req?.socket?.remoteAddress || '');
}

module.exports = { normalizeIp, clientIp };
