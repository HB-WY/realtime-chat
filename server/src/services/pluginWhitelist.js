// src/services/pluginWhitelist.js
//
// 插件代理白名单 —— 独立 yaml 文件，**支持热重载**。
//
// 为什么独立于 config.yaml：
//   白名单是运营侧频繁修改的东西（新插件上线 / 修 origin / 临时下线）。
//   config.yaml 是启动配置，改一次必须重启；白名单不该有这个负担。
//   这里通过 stat mtime 检测文件变化，下一次请求时自动重读 —— 无需重启。
//
// 为什么独立于 manifest.proxy：
//   manifest 随插件包走，意味着：
//     · 只有 developer 能上传带 proxy 的插件（安全考虑，但限制了运营）
//     · 重装插件会覆盖白名单
//     · 管理员想临时禁用某插件的代理，得改插件包
//   独立 yaml 之后，白名单由运维单独管理，与插件版本解耦。
//
// 安全约束（与 config.yaml 的文件类型校验口径一致）：
//   · 只允许 https（防降级）
//   · 只允许 origin（不含 path / query / fragment）
//   · 不允许带认证信息（user:pass@）
//   · 不支持通配符
//   · 每插件最多 10 条
//
// 解析失败时的策略：
//   · YAML 语法错误 / 顶层不是对象 / 文件读不到 → **保留上一次的有效配置**
//   · 单条 origin 不合法 → 打印警告 + 跳过该条，其余保留
//   · 这与 files.types 的处理一致（一条坏数据不该让整个功能不可用）
//
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// 与 config.yaml 同目录（server/ 根目录）
const FILE = path.join(__dirname, '..', '..', 'plugin-whitelist.yaml');
const MAX_HOSTS = 10;
const RELOAD_MAX_AGE_MS = 30 * 1000;   // 兜底：即使 mtime 没变，30 秒也重读一次

// 缓存：{ at, mtimeMs, data: { pluginId: [origin...] } }
let cached = { at: 0, mtimeMs: 0, data: {} };

// ------------------------------------------------------------
// 单条 origin 的规范化（与旧 services/plugins.js::normalizeProxy 口径一致）
// ------------------------------------------------------------
function normalizeOrigin(raw, pluginId) {
  const s = String(raw || '').trim();
  if (!s) return null;

  let u;
  try {
    u = new URL(s);
  } catch {
    console.warn(`[plugin-whitelist] ${pluginId}：非法 URL「${s}」，已跳过`);
    return null;
  }
  if (u.protocol !== 'https:') {
    console.warn(`[plugin-whitelist] ${pluginId}：「${s}」不是 https，已跳过`);
    return null;
  }
  if (u.username || u.password) {
    console.warn(`[plugin-whitelist] ${pluginId}：「${s}」不允许带认证信息，已跳过`);
    return null;
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    console.warn(`[plugin-whitelist] ${pluginId}：「${s}」只能是 origin（不能带路径），已跳过`);
    return null;
  }
  if (u.search || u.hash) {
    console.warn(`[plugin-whitelist] ${pluginId}：「${s}」不能带 query/fragment，已跳过`);
    return null;
  }
  if (u.hostname.includes('*')) {
    console.warn(`[plugin-whitelist] ${pluginId}：「${s}」不支持通配符，已跳过`);
    return null;
  }
  return u.origin;
}

// ------------------------------------------------------------
// 读盘 + 解析（不抛错，失败返回 null 让调用方保留旧缓存）
// ------------------------------------------------------------
function parseFile() {
  if (!fs.existsSync(FILE)) {
    // 文件不存在是合法状态：视作「所有插件都没有代理白名单」
    return {};
  }

  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    console.warn('[plugin-whitelist] 读取失败：', err.message);
    return null;
  }

  let raw;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    console.warn('[plugin-whitelist] YAML 解析失败：', err.message);
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[plugin-whitelist] 顶层必须是对象（pluginId → origin 列表）');
    return null;
  }

  const out = {};
  for (const [pluginId, list] of Object.entries(raw)) {
    // 与 services/plugins.js::ID_RE 保持一致：小写字母开头，2-32 位
    if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(pluginId)) {
      console.warn(`[plugin-whitelist] 非法插件 id「${pluginId}」，已跳过`);
      continue;
    }
    if (!Array.isArray(list)) {
      console.warn(`[plugin-whitelist] ${pluginId} 的值必须是数组，已跳过`);
      continue;
    }

    const normalized = [];
    const seen = new Set();
    for (const item of list.slice(0, MAX_HOSTS)) {
      const origin = normalizeOrigin(item, pluginId);
      if (!origin) continue;
      if (seen.has(origin)) continue;
      seen.add(origin);
      normalized.push(origin);
    }
    if (normalized.length > 0) out[pluginId] = normalized;
  }
  return out;
}

// ------------------------------------------------------------
// 对外：读某插件的白名单
// ------------------------------------------------------------
/**
 * @param {string} pluginId
 * @returns {string[]}  精确 origin 列表；无白名单时返回空数组
 */
function getAllowList(pluginId) {
  const now = Date.now();

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(FILE).mtimeMs;
  } catch {
    /* 文件不存在：视作空表 */
  }

  // 触发重读的条件：
  //   · mtime 变了（最常用）
  //   · 兜底：距上次读超过 30 秒（防御某些文件系统 mtime 精度问题）
  if (!cached.mtimeMs || mtimeMs !== cached.mtimeMs || now - cached.at > RELOAD_MAX_AGE_MS) {
    const data = parseFile();
    if (data === null) {
      // 解析失败：保留旧缓存，只是把 at 推进，避免每次都读盘
      cached.at = now;
      console.warn('[plugin-whitelist] 解析失败，保留上一次有效配置');
    } else {
      const prevCount = Object.keys(cached.data).length;
      cached = { at: now, mtimeMs, data };
      if (prevCount !== Object.keys(data).length) {
        console.log(`[plugin-whitelist] 已重载：${Object.keys(data).length} 个插件有白名单`);
      }
    }
  }

  return cached.data[pluginId] || [];
}

// ------------------------------------------------------------
// 对外：全量（管理接口 / 调试用）
// ------------------------------------------------------------
function all() {
  // 拉一次以保证返回的是最新值
  getAllowList('__probe__');
  return { ...cached.data };
}

// ------------------------------------------------------------
// 对外：手动重置缓存（测试用）
// ------------------------------------------------------------
function reset() {
  cached = { at: 0, mtimeMs: 0, data: {} };
}

module.exports = {
  FILE,
  MAX_HOSTS,
  getAllowList,
  all,
  reset
};