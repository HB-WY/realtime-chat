// src/config.js
//
// 配置加载优先级（后者覆盖前者）：
//   1. config.yaml
//   2. config.local.yaml（可选，本地覆盖）
//   3. 环境变量（仅少量关键项）
//
// 环境变量：
//   APP_CONFIG      指定主配置文件路径
//   APP_ENV         覆盖 server.env
//   PORT            覆盖 server.port
//   HOST            覆盖 server.host
//   SERVE_CLIENT    0/false 关闭「后端托管前端产物」
//   JWT_SECRET      覆盖 security.jwt.secret
//   ALLOWED_HOSTS   逗号分隔，覆盖 security.allowed_referer_hosts
//
// 命令行（优先于环境变量）：
//   node index.js --host 0.0.0.0 --port 3001
//

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');

// ---------- 工具：深合并 ----------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// ---------- 加载单个文件 ----------
function loadYaml(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const parsed = YAML.parse(text);
  if (!isPlainObject(parsed)) {
    throw new Error(`[config] ${file} 解析结果不是对象`);
  }
  return parsed;
}

// ---------- 主加载 ----------
const mainFile  = process.env.APP_CONFIG || path.join(ROOT, 'config.yaml');
const localFile = path.join(ROOT, 'config.local.yaml');

const mainCfg = loadYaml(mainFile);
if (!mainCfg) throw new Error(`[config] 找不到主配置：${mainFile}`);
const localCfg = loadYaml(localFile);

let raw = deepMerge(mainCfg, localCfg || {});

// ---------- 环境变量覆盖 ----------
const envOverride = {};

if (process.env.APP_ENV) {
  envOverride.server = { ...(envOverride.server || {}), env: process.env.APP_ENV };
}
if (process.env.PORT) {
  envOverride.server = { ...(envOverride.server || {}), port: Number(process.env.PORT) };
}
if (process.env.HOST) {
  envOverride.server = { ...(envOverride.server || {}), host: process.env.HOST };
}
if (process.env.JWT_SECRET) {
  envOverride.security = {
    ...(envOverride.security || {}),
    jwt: { ...(envOverride.security?.jwt || {}), secret: process.env.JWT_SECRET }
  };
}
if (process.env.ALLOWED_HOSTS) {
  envOverride.security = {
    ...(envOverride.security || {}),
    allowed_referer_hosts: process.env.ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
  };
}

// ---------- 命令行覆盖 ----------
{
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const argHost = argOf('host');
  const argPort = argOf('port');
  if (argHost) envOverride.server = { ...(envOverride.server || {}), host: argHost };
  if (argPort && Number(argPort) > 0) {
    envOverride.server = { ...(envOverride.server || {}), port: Number(argPort) };
  }
}

raw = deepMerge(raw, envOverride);

// ---------- 校验 ----------
function require_(cond, msg) {
  if (!cond) throw new Error(`[config] ${msg}`);
}

require_(raw.server && typeof raw.server.port === 'number', 'server.port 必须是数字');
require_(raw.database && typeof raw.database.path === 'string', 'database.path 必须是字符串');
require_(raw.security?.jwt?.secret, 'security.jwt.secret 不能为空');

const isProd = raw.server.env === 'production';
// [SEC] 默认密钥是全网公开值。生产环境直接拒绝启动；
//       任何「对外监听」（非回环地址，如 --host 0.0.0.0 / 局域网 IP）
//       同样拒绝 —— 否则 start:lan 一开，同网段任何人都能伪造
//       developer token 拿到全部管理能力。
const isDefaultSecret = raw.security.jwt.secret === 'change-me-in-production';
const host = String(raw.server.host || '127.0.0.1').trim().toLowerCase();
const isLoopbackHost =
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
if (isDefaultSecret && (isProd || !isLoopbackHost)) {
  console.error(
    '[config] 检测到默认 JWT 密钥' + (isProd ? '（生产环境）' : `（且监听地址 ${host} 对外开放）`) + '。\n' +
    '         必须设置随机密钥后再启动，例如：\n' +
    '         JWT_SECRET=$(openssl rand -hex 32) npm start\n' +
    '         （或修改 config.local.yaml 的 security.jwt.secret）'
  );
  process.exit(1);
}

// ---------- 兜底默认值 ----------
raw.server             = raw.server || {};
if (typeof raw.server.host !== 'string' || !raw.server.host.trim()) {
  raw.server.host = '127.0.0.1';
}
raw.security           = raw.security || {};
raw.security.jwt       = raw.security.jwt || {};
raw.uploads            = raw.uploads || {};
raw.uploads.limits     = raw.uploads.limits || {};
raw.uploads.avatar     = raw.uploads.avatar || {};
raw.uploads.subdirs    = raw.uploads.subdirs || {};
raw.static             = raw.static || {};
raw.static.expose      = Array.isArray(raw.static.expose) ? raw.static.expose : [];
raw.business           = raw.business || {};
raw.business.shop      = raw.business.shop || {};
raw.business.shop.plagiarism = raw.business.shop.plagiarism || {};
raw.business.assets    = raw.business.assets || {};
raw.business.stickers  = raw.business.stickers || {};
raw.business.preferences = raw.business.preferences || {};
raw.business.preferences.font_size = raw.business.preferences.font_size || {};
raw.business.user      = raw.business.user || {};
raw.business.user.username = raw.business.user.username || {};
raw.business.user.password = raw.business.user.password || {};
raw.business.user.nickname = raw.business.user.nickname || {};
raw.business.user.signature = raw.business.user.signature || { max_len: 60 };
raw.business.user.group_name = raw.business.user.group_name || {};
raw.business.message   = raw.business.message || {};
raw.rate_limits        = raw.rate_limits || {};
raw.rate_limits.socket  = raw.rate_limits.socket || {};
raw.rate_limits.socket.message = raw.rate_limits.socket.message || { per_second: 5, per_minute: 200 };
raw.rate_limits.socket.write   = raw.rate_limits.socket.write   || { per_second: 10, per_minute: 300 };
raw.rate_limits.socket.presence = raw.rate_limits.socket.presence || { per_second: 10, per_minute: 600 };
raw.rate_limits.download = raw.rate_limits.download || { window_ms: 60000, max: 10 };
raw.rate_limits.preview = raw.rate_limits.preview || { window_ms: 60000, max: 60 };
if (!(Number(raw.rate_limits.preview.window_ms) > 0)) raw.rate_limits.preview.window_ms = 60000;
if (!(Number(raw.rate_limits.preview.max) > 0))       raw.rate_limits.preview.max = 60;
raw.rate_limits.apikey  = raw.rate_limits.apikey || { window_ms: 60000, max: 600 };
raw.rate_limits.login   = raw.rate_limits.login || {};
// [NEW] 注册限流（按 IP）
raw.rate_limits.register = raw.rate_limits.register || {};
if (!(Number(raw.rate_limits.register.window_ms) > 0))   raw.rate_limits.register.window_ms = 3600000;
if (!(Number(raw.rate_limits.register.max_per_ip) > 0))  raw.rate_limits.register.max_per_ip = 30;
// [NEW] 上传通道限流（按用户，所有上传接口共用）
raw.rate_limits.upload = raw.rate_limits.upload || {};
if (!(Number(raw.rate_limits.upload.window_ms) > 0)) raw.rate_limits.upload.window_ms = 60000;
if (!(Number(raw.rate_limits.upload.max) > 0))       raw.rate_limits.upload.max = 20;
// [NEW] 转码状态查询限流（按用户）
raw.rate_limits.media_status = raw.rate_limits.media_status || {};
if (!(Number(raw.rate_limits.media_status.window_ms) > 0)) raw.rate_limits.media_status.window_ms = 60000;
if (!(Number(raw.rate_limits.media_status.max) > 0))       raw.rate_limits.media_status.max = 120;
if (!(Number(raw.rate_limits.login.window_ms) > 0))       raw.rate_limits.login.window_ms = 900000;
if (!(Number(raw.rate_limits.login.max_per_ip) > 0))      raw.rate_limits.login.max_per_ip = 30;
if (!(Number(raw.rate_limits.login.max_per_account) > 0)) raw.rate_limits.login.max_per_account = 10;

// [NEW] REST 通道限流（按用户）：/api/v1/* 与 /api/messages 等镜像端点。
//   与 socket 的参数**分开**，因为两者面对的场景不同：
//     · socket 主要面对真人（5/s 已是极限，很紧）
//     · REST + API 密钥主要面对脚本（批量调用是正常用法）
//   已有的 rate_limits.apikey（600/min）依然是**总闸**兜底。
//   三个类别分开计数（不共用一个桶）：
//     message —— 发消息（POST /messages）
//     search  —— 搜索 / 状态 / 在线列表
//     history —— 拉历史（GET /messages）
//   见 routes/v1.js 顶部说明。
raw.rate_limits.rest = raw.rate_limits.rest || {};
{
  const rnum = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const defaults = {
    message: { per_second: 20, per_minute: 600 },
    search:  { per_second: 10, per_minute: 300 },
    history: { per_second: 20, per_minute: 600 }
  };
  for (const [key, def] of Object.entries(defaults)) {
    const cur = raw.rate_limits.rest[key] || {};
    raw.rate_limits.rest[key] = {
      per_second: rnum(cur.per_second, def.per_second),
      per_minute: rnum(cur.per_minute, def.per_minute)
    };
  }
}

// 插件桥调用限流
raw.rate_limits.plugin  = raw.rate_limits.plugin || { window_ms: 60000, max: 600 };
if (!(Number(raw.rate_limits.plugin.window_ms) > 0)) raw.rate_limits.plugin.window_ms = 60000;
if (!(Number(raw.rate_limits.plugin.max) > 0))       raw.rate_limits.plugin.max = 600;
// 插件支付限流
raw.rate_limits.plugin_payment = raw.rate_limits.plugin_payment || { window_ms: 3600000, max: 30 };
if (!(Number(raw.rate_limits.plugin_payment.window_ms) > 0)) raw.rate_limits.plugin_payment.window_ms = 3600000;
if (!(Number(raw.rate_limits.plugin_payment.max) > 0))       raw.rate_limits.plugin_payment.max = 30;
raw.security.apikey     = raw.security.apikey || {};

// ---------- [NEW] 双 token 认证（Cookie + 刷新令牌） ----------
//   全部字段都有代码兜底：config.yaml 里整段删掉也能启动。
raw.security.auth = raw.security.auth || {};
{
  const A = raw.security.auth;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);

  raw.security.auth = {
    access_ttl: str(A.access_ttl, '15m'),
    refresh_ttl_ms: num(A.refresh_ttl_ms, 30 * 24 * 3600 * 1000),
    refresh_cookie_name: str(A.refresh_cookie_name, 'rt'),
    refresh_cookie_path: str(A.refresh_cookie_path, '/api/auth'),
    allow_legacy_bearer: A.allow_legacy_bearer !== false
  };
}

raw.client = raw.client || {};
if (typeof raw.client.dist !== 'string' || !raw.client.dist.trim()) {
  raw.client.dist = '../client/dist';
}
raw.security.allowed_referer_hosts = Array.isArray(raw.security.allowed_referer_hosts)
  ? raw.security.allowed_referer_hosts : [];

raw.files = raw.files || {};
raw.files.types = Array.isArray(raw.files.types) ? raw.files.types : [];

// ---------- 音视频转码 ----------
raw.media = raw.media || {};
raw.media.transcode = raw.media.transcode || {};
{
  const mt = raw.media.transcode;
  const mnum = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const mstr = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const mvideo = mt.video || {};
  const maudio = mt.audio || {};
  const crf = Number(mvideo.crf);

  raw.media.transcode = {
    enabled: mt.enabled !== false,
    ffmpeg: mstr(mt.ffmpeg, 'ffmpeg'),
    ffprobe: mstr(mt.ffprobe, 'ffprobe'),
    concurrency: Math.min(Math.max(Math.round(mnum(mt.concurrency, 2)), 1), 8),
    timeout_ms: Math.round(mnum(mt.timeout_ms, 30 * 60 * 1000)),
    probe_timeout_ms: Math.round(mnum(mt.probe_timeout_ms, 15000)),
    max_queue: Math.round(mnum(mt.max_queue, 50)),
    max_source_bytes: Number(mt.max_source_bytes) > 0 ? Number(mt.max_source_bytes) : 0,
    video: {
      crf: Number.isFinite(crf) ? Math.min(Math.max(Math.round(crf), 0), 51) : 23,
      preset: mstr(mvideo.preset, 'veryfast'),
      audio_bitrate: mstr(mvideo.audio_bitrate, '128k'),
      max_height: Number(mvideo.max_height) > 0 ? Math.round(Number(mvideo.max_height)) : 0
    },
    audio: {
      bitrate: mstr(maudio.bitrate, '192k')
    }
  };
}

// ---------- 支付系统（转账 + 红包） ----------
// 全部字段都有代码兜底默认值：整段删掉也能启动。
raw.payments = raw.payments || {};
{
  const P = raw.payments;
  const tnum = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const t = P.transfer || {};
  const r = P.redpacket || {};
  const rl = P.rate_limit || {};

  raw.payments = {
    transfer: {
      min_amount:   Math.max(1, tnum(t.min_amount, 1)),
      max_amount:   Math.max(1, tnum(t.max_amount, 10000)),
      daily_limit:  Math.max(1, tnum(t.daily_limit, 50000)),
      expire_hours: Math.max(1, tnum(t.expire_hours, 24)),
      note_max_len: Math.max(0, tnum(t.note_max_len, 50))
    },
    redpacket: {
      min_amount_per_pack: Math.max(1, tnum(r.min_amount_per_pack, 1)),
      max_amount:          Math.max(1, tnum(r.max_amount, 10000)),
      max_count:           Math.max(1, tnum(r.max_count, 100)),
      expire_hours:        Math.max(1, tnum(r.expire_hours, 24)),
      note_max_len:        Math.max(0, tnum(r.note_max_len, 20))
    },
    rate_limit: {
      window_ms: Math.max(1000, tnum(rl.window_ms, 60000)),
      max:       Math.max(1,    tnum(rl.max, 10))
    }
  };
}

require_(
  typeof raw.security.blocked_ext === 'string' && raw.security.blocked_ext.trim(),
  'security.blocked_ext 必须是非空正则字符串'
);
require_(
  Array.isArray(raw.security.blocked_mime),
  'security.blocked_mime 必须是数组'
);

// ---------- 编译正则 ----------
let blockedExt;
try {
  blockedExt = new RegExp(raw.security.blocked_ext, 'i');
} catch (err) {
  throw new Error(`[config] security.blocked_ext 不是合法正则: ${err.message}`);
}
const blockedMime = new Set(raw.security.blocked_mime);

// ---------- 文件类型 ----------
const { normalizeImageUrl } = require('./utils/url');

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const TYPE_KEY = /^[a-z0-9_-]{1,20}$/;
const EXT_BODY = /^[a-z0-9]{1,10}$/;
const MAX_TYPES = 50;

function normalizeFileTypes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, MAX_TYPES)) {
    if (!item || typeof item !== 'object') {
      console.warn('[config] files.types 里有非对象条目，已跳过');
      continue;
    }
    const key = String(item.key || '').trim().toLowerCase();
    if (!TYPE_KEY.test(key)) {
      console.warn(`[config] files.types「${item.key}」的 key 不合法（小写字母/数字/_/-，≤20 位），已跳过`);
      continue;
    }
    if (seen.has(key)) {
      console.warn(`[config] files.types 里 key「${key}」重复，后者已跳过`);
      continue;
    }
    const exts = (Array.isArray(item.exts) ? item.exts : [])
      .map((e) => `.${String(e || '').trim().toLowerCase().replace(/^\.+/, '')}`)
      .filter((e) => EXT_BODY.test(e.slice(1)));
    if (exts.length === 0) {
      console.warn(`[config] files.types「${key}」没有合法扩展名（形如 .psd），已跳过`);
      continue;
    }
    let cover = null;
    try {
      cover = normalizeImageUrl(item.cover, `files.types「${key}」的 cover`);
    } catch (err) {
      console.warn(`[config] ${err.message}，该类型按「无封面」处理`);
    }
    const color = HEX_COLOR.test(String(item.color || '')) ? String(item.color) : '#64748b';
    seen.add(key);
    out.push({
      key,
      label: (String(item.label || '').trim() || key.toUpperCase()).slice(0, 6),
      color,
      exts,
      cover
    });
  }
  return out;
}

const FILE_TYPES = normalizeFileTypes(raw.files.types);

// ---------- 插件配置 ----------
raw.plugins = raw.plugins || {};

/** 允许的权限白名单（manifest.permissions 里只能出现这些值） */
const ALLOWED_PLUGIN_PERMISSIONS = new Set(
  Array.isArray(raw.plugins.allowed_permissions) && raw.plugins.allowed_permissions.length > 0
    ? raw.plugins.allowed_permissions
    : [
        'user:read', 'user:friends', 'room:list', 'message:send',
        'storage', 'ui:toast', 'ui:close', 'payment:request'
      ]
);

const PLUGIN_CFG = {
  enabled: raw.plugins.enabled !== false,

  // 体积 / 数量
  max_bundle_bytes: Math.max(1024, Number(raw.plugins.max_bundle_bytes) || 5 * 1024 * 1024),
  max_file_bytes: Math.max(512, Number(raw.plugins.max_file_bytes) || 1024 * 1024),
  max_files_per_plugin: Math.max(1, Math.min(Number(raw.plugins.max_files_per_plugin) || 100, 500)),

  // 用户限制
  max_installed_per_user: Math.max(1, Number(raw.plugins.max_installed_per_user) || 50),
  max_published_per_user: Math.max(1, Number(raw.plugins.max_published_per_user) || 20),

  // KV 存储
  kv_quota_bytes: Math.max(1024, Number(raw.plugins.kv_quota_bytes) || 100 * 1024),
  kv_value_max_bytes: Math.max(256, Number(raw.plugins.kv_value_max_bytes) || 16384),

  // 权限白名单
  allowed_permissions: ALLOWED_PLUGIN_PERMISSIONS,

  // 支付
  payment: {
    max_single: Math.max(1, Number(raw.plugins.payment?.max_single) || 10000),
    default_single: Math.max(1, Number(raw.plugins.payment?.default_single) || 1000),
    // [CHANGED] 从"每日金额上限"（max_daily_per_plugin）改为"每日笔数上限"。
    //   见 config.yaml 的注释；旧字段名被有意不再读取（改配置时也要跟着换）。
    max_daily_count_per_plugin: Math.max(1, Number(raw.plugins.payment?.max_daily_count_per_plugin) || 100),
    refund_window_ms: Math.max(0, Number(raw.plugins.payment?.refund_window_ms) || 7 * 24 * 3600 * 1000)
  }
};

// ---------- 路径解析 ----------
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const uploadRoot = abs(raw.uploads.root);
const subdirs = raw.uploads.subdirs || {};
const dirOf = (key) => path.join(uploadRoot, subdirs[key] || key);

// ---------- 导出 ----------
module.exports = {
  // 元信息
  ROOT,
  ENV: raw.server.env,
  IS_PROD: isProd,

  // 数据库
  DB_PATH: abs(raw.database.path),
  DB_JOURNAL_MODE: raw.database.journal_mode,
  DB_FOREIGN_KEYS: raw.database.foreign_keys,

  // 上传目录
  UPLOAD_ROOT: uploadRoot,
  AVATAR_DIR:  dirOf('avatars'),
  FILE_DIR:    dirOf('files'),
  SHOP_DIR:    dirOf('shop'),
  COVER_DIR:   dirOf('covers'),
  CUSTOM_DIR:  dirOf('custom'),
  TMP_DIR:     dirOf('tmp'),
  PLUGIN_DIR:  dirOf('plugins'),

  // JWT / server
  JWT_SECRET:  raw.security.jwt.secret,
  JWT_EXPIRES: raw.security.jwt.expiresIn,
  PORT:        raw.server.port,
  HOST:        raw.server.host,

  // 上传大小上限
  AVATAR_MAX:    raw.uploads.limits.avatar,
  FILE_MAX:      raw.uploads.limits.file,
  SHOP_FILE_MAX: raw.uploads.limits.shop_file,
  COVER_MAX:     raw.uploads.limits.cover,
  ASSET_MAX:     raw.uploads.limits.asset,

  // 上传黑名单
  BLOCKED_EXT:  blockedExt,
  BLOCKED_MIME: blockedMime,

  // Referer 白名单
  ALLOWED_REFERER_HOSTS: raw.security.allowed_referer_hosts || [],

  // 安全开关
  TRUST_PROXY: raw.security.trust_proxy === true,
  PRESENCE_SCOPE: raw.security.presence?.scope === 'all' ? 'all' : 'related',

  // [NEW] 双 token 认证
  AUTH_CFG: raw.security.auth,

  // 前端静态托管
  SERVE_CLIENT: raw.client.serve !== false && process.env.SERVE_CLIENT !== '0',
  CLIENT_DIST: abs(raw.client.dist),

  // 静态目录
  STATIC_EXPOSE: raw.static.expose,

  // 头像
  AVATAR_ALLOWED_EXT: raw.uploads.avatar.allowed_ext,
  AVATAR_ALLOWED_MIME_PREFIX: raw.uploads.avatar.allowed_mime_prefix,
  AVATAR_MAX_URL_LEN: raw.uploads.avatar.max_url_len,
  AVATAR_MAX_DATA_URL_LEN: raw.uploads.avatar.max_data_url_len,

  // 业务
  BUSINESS:  raw.business,
  RATE_LIMITS: raw.rate_limits,
  ROLES_CFG: raw.roles,
  OFFICIAL_ACCOUNT: raw.official_account,

  // 资源池 / 表情包 / 个性化偏好
  ASSETS_CFG:  raw.business.assets,
  STICKER_CFG: raw.business.stickers,
  PREF_CFG:    raw.business.preferences,

  // API 密钥通道
  APIKEY_CFG:  raw.security.apikey || {},
  APIKEY_RATE: raw.rate_limits.apikey,

  // 开发者自定义的文件类型
  FILE_TYPES,

  // 音视频转码
  TRANSCODE_CFG: raw.media.transcode,

  // 支付系统（转账 / 红包）
  PAYMENTS_CFG: raw.payments,

  // 插件系统
  PLUGIN_CFG,

  // 原始对象（调试用）
  _raw: raw
};