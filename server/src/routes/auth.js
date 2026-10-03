// server/src/routes/auth.js
//
// 认证端点（挂载在 /api/auth 下，见 routes/index.js：
//   router.use('/auth', require('./auth'))
// —— 所以内部路由**不带** /auth 前缀）：
//   POST /api/auth/register  注册（下发 Access + Refresh）
//   POST /api/auth/login     登录（下发 Access + Refresh）
//   POST /api/auth/refresh   用 Refresh Cookie 换新 Access（+ 轮换 Refresh）
//   POST /api/auth/logout    撤销当前 Refresh Token + 清 Cookie
//   GET  /api/auth/me        当前用户（需 Access）
//
// [SEC] Refresh Token 走 HttpOnly Cookie（Path=/api/auth），前端 JS 拿不到；
//       Access Token 在响应体里返回，前端存内存。
//       刷新端点的 CSRF 靠 SameSite=Strict + Origin 校验兜底。
//
// [FIX] 路由路径去掉 /auth 前缀 —— 挂载时已有 `/auth`，内部再写就成了
//       `/api/auth/auth/register`。之前误改，导致注册/登录全部 404。
//
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authMiddleware } = require('../auth');
const { signAccessToken } = require('../auth/tokens');
const refreshTokens = require('../services/refreshTokens');
const {
  setRefreshCookie, clearRefreshCookie, getCookie, REFRESH_COOKIE
} = require('../auth/cookies');
const loginGuard = require('../auth/loginGuard');
const { ensureAccount } = require('../services/points');
const { sanitizeAvatar } = require('../utils/avatar');
const { clientIp } = require('../utils/ip');
const config = require('../config');

const U = config.BUSINESS.user;
const AUTH = config.AUTH_CFG;

const router = express.Router();

// ============================================================
// 注册限流（按 IP，滑动窗口）
//
// [SEC] 注册接口原本零限流、零验证码，且每个新号自动送 signup_points
// 积分（可立即转账 / 消费）—— 脚本可以无限刷号通胀积分经济。
// ============================================================
const REG_RL = config.RATE_LIMITS.register || {};
const REG_WINDOW_MS = Number(REG_RL.window_ms) > 0 ? Number(REG_RL.window_ms) : 3600000;
const REG_MAX_PER_IP = Number(REG_RL.max_per_ip) > 0 ? Number(REG_RL.max_per_ip) : 10;

const regHits = new Map();
let regOps = 0;

function regPrune() {
  const now = Date.now();
  for (const [ip, arr] of regHits) {
    const kept = arr.filter((t) => now - t < REG_WINDOW_MS);
    if (kept.length === 0) regHits.delete(ip);
    else if (kept.length !== arr.length) regHits.set(ip, kept);
  }
}

const regPruneTimer = setInterval(regPrune, 5 * 60 * 1000);
if (typeof regPruneTimer.unref === 'function') regPruneTimer.unref();

function registerAllowed(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const arr = (regHits.get(ip) || []).filter((t) => now - t < REG_WINDOW_MS);
  if (arr.length >= REG_MAX_PER_IP) {
    const wait = Math.ceil((REG_WINDOW_MS - (now - arr[0])) / 1000);
    regHits.set(ip, arr);
    return { ok: false, wait };
  }
  arr.push(now);
  regHits.set(ip, arr);
  if (++regOps >= 500) { regOps = 0; regPrune(); }
  return { ok: true };
}

// 用户名字符集白名单：字母 / 数字 / 下划线 / 连字符 / 点 / 中日韩文字。
// [SEC] 原先长度之外任意字符（含控制字符、零宽字符、HTML 标签片段）都能入库。
const USERNAME_RE = /^[\p{L}\p{N}_.\-]+$/u;

// ============================================================
// 会话建立（注册 / 登录共用）
// ============================================================
function establishSession(req, res, user) {
  // 1) Access Token（响应体）—— 前端存内存
  const accessToken = signAccessToken(user);

  // 2) Refresh Token（HttpOnly Cookie）—— 库只存 hash
  const issued = refreshTokens.issue(user.id, {
    userAgent: req.headers['user-agent'] || '',
    ip: clientIp(req)
  });
  setRefreshCookie(req, res, issued.plain, AUTH.refresh_ttl_ms);

  return { accessToken, refreshExpiresAt: issued.expiresAt };
}

// ============================================================
// 注册
//   POST /api/auth/register
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: '用户名和密码必须是字符串' });
    }

    const gate = registerAllowed(req);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.wait));
      return res.status(429).json({ error: `注册过于频繁，请 ${gate.wait} 秒后再试` });
    }

    if (username.length < U.username.min_len || username.length > U.username.max_len) {
      return res.status(400).json({
        error: `用户名长度需为 ${U.username.min_len}-${U.username.max_len} 个字符`
      });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: '用户名只能包含字母、数字、下划线、点、连字符或中文'
      });
    }
    if (password.length < U.password.min_len) {
      return res.status(400).json({ error: `密码至少 ${U.password.min_len} 位` });
    }

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: '用户名已存在' });

    const hash = await bcrypt.hash(password, 10);
    const finalNick = (nickname || '').trim() || username;
    if (finalNick.length < U.nickname.min_len || finalNick.length > U.nickname.max_len) {
      return res.status(400).json({
        error: `昵称长度需为 ${U.nickname.min_len}-${U.nickname.max_len} 个字符`
      });
    }

    const avatar = sanitizeAvatar(req.body?.avatar);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, nickname, avatar, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hash, finalNick, avatar, Date.now());
    const userId = Number(info.lastInsertRowid);

    ensureAccount(userId);

    const user = { id: userId, username, nickname: finalNick, avatar, signature: '', role: 'user' };
    const { accessToken } = establishSession(req, res, user);

    res.json({
      accessToken,
      token: accessToken,      // [兼容] 老前端读 data.token；稳定 30 天后可删
      user
    });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: '注册失败' });
  }
});

// ============================================================
// 登录
//   POST /api/auth/login
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    // [SEC] 失败次数限流必须**排在查库与 bcrypt 之前**：否则攻击者就算被
    //       限流，也仍然能靠 bcrypt 的计算量把服务拖慢（放大 DoS）。
    const gate = loginGuard.check(req, username);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      return res.status(429).json({
        error: `登录失败次数过多，请 ${gate.retryAfter} 秒后再试`
      });
    }

    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) {
      loginGuard.fail(req, username);
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      loginGuard.fail(req, username);
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 凭据正确，但账号不可用 —— 属正常业务拒绝，不计入失败次数
    if (row.status === 'disabled') {
      return res.status(403).json({ error: '账号已被禁用' });
    }
    if (row.status === 'banned') {
      return res.status(403).json({ error: '账号已被查封' });
    }

    // 登录成功：清掉该账号的失败计数（IP 维度保留，见 loginGuard.reset 注释）
    loginGuard.reset(req, username);

    const user = {
      id: row.id, username: row.username, nickname: row.nickname,
      avatar: row.avatar || '', signature: row.signature || '', role: row.role || 'user'
    };
    const { accessToken } = establishSession(req, res, user);

    res.json({
      accessToken,
      token: accessToken,      // [兼容]
      user
    });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// ============================================================
// 刷新（用 Refresh Cookie 换新 Access，并轮换 Refresh）
//   POST /api/auth/refresh
//
// [SEC] 这个端点是唯一读 Refresh Cookie 的地方，Cookie 的 Path 限定为
//       /api/auth，SameSite=Strict 让跨站请求带不上它。
//       另外再做一层 Origin 校验，覆盖"同站子域"这类 Strict 挡不住的场景。
// ============================================================
function originAllowed(req) {
  const origin = req.headers.origin;
  // 没有 Origin 头：可能来自同源 fetch（现代浏览器通常还是会带），放行；
  // 也可来自 curl 等脚本 —— 但脚本走 API 密钥通道，不需要 Refresh。
  if (!origin) return true;
  try {
    const u = new URL(origin);
    // 只允许同 host（忽略端口差异，允许反代端口转换）
    const host = req.headers.host || '';
    const hostName = host.split(':')[0];
    return u.hostname === hostName;
  } catch {
    return false;
  }
}

router.post('/refresh', (req, res) => {
  try {
    if (!originAllowed(req)) {
      clearRefreshCookie(req, res);
      return res.status(403).json({ error: '非法来源', code: 'CSRF_BLOCKED' });
    }

    const plain = getCookie(req, REFRESH_COOKIE);
    if (!plain) {
      return res.status(401).json({ error: '未登录', code: 'NO_REFRESH' });
    }

    const out = refreshTokens.rotate(plain, {
      userAgent: req.headers['user-agent'] || '',
      ip: clientIp(req)
    });

    if (!out.ok) {
      // 无论哪种失败都清 Cookie（让前端明确"需要重新登录"）
      clearRefreshCookie(req, res);
      const codeMap = {
        not_found: 'REFRESH_INVALID',
        expired: 'REFRESH_EXPIRED',
        revoked: 'REFRESH_REVOKED',
        replayed: 'REFRESH_REPLAYED'
      };
      const msgMap = {
        not_found: '登录已过期，请重新登录',
        expired: '登录已过期，请重新登录',
        revoked: '登录凭据已被撤销，请重新登录',
        replayed: '检测到登录凭据异常使用，已强制退出，请重新登录'
      };
      return res.status(401).json({ error: msgMap[out.reason], code: codeMap[out.reason] });
    }

    // 加载用户；被封禁 / 禁用的账号即时失效
    const user = db.prepare(
      'SELECT id, username, nickname, avatar, signature, role, status FROM users WHERE id = ?'
    ).get(out.userId);
    if (!user || user.status !== 'active') {
      refreshTokens.revokeFamily(out.newFamilyId);
      clearRefreshCookie(req, res);
      return res.status(401).json({ error: '用户不存在或已被禁用', code: 'USER_INACTIVE' });
    }

    // 下发新的 Refresh Cookie（轮换）
    setRefreshCookie(req, res, out.newPlain, AUTH.refresh_ttl_ms);

    const safeUser = {
      id: user.id, username: user.username, nickname: user.nickname,
      avatar: user.avatar || '', signature: user.signature || '', role: user.role || 'user'
    };
    const accessToken = signAccessToken(safeUser);

    res.json({ accessToken, user: safeUser });
  } catch (err) {
    console.error('[refresh]', err);
    res.status(500).json({ error: '刷新失败' });
  }
});

// ============================================================
// 登出：撤销当前 Refresh Token + 清 Cookie
//   POST /api/auth/logout
// ============================================================
router.post('/logout', (req, res) => {
  try {
    const plain = getCookie(req, REFRESH_COOKIE);
    if (plain) refreshTokens.revokeByToken(plain);
  } catch (err) {
    console.error('[logout]', err);
  }
  clearRefreshCookie(req, res);
  res.json({ ok: true });
});

// ============================================================
// 当前用户
//   GET /api/auth/me
// ============================================================
router.get('/me', authMiddleware, (req, res) => res.json({ user: req.user }));

module.exports = router;