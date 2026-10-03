# 小程序（插件）开发守则

> 版本：对应宿主插件系统 **v3**（多页面路由 + 版本历史 + 真流式代理）
>
> 适用对象：**插件开发者**。若你是宿主维护者，请阅读 `DEVLOG.md` / `ERRORLOG.md`。
>
> 最后更新：2026-10-03

---

## 目录

1. [概述](#1-概述)
2. [项目结构](#2-项目结构)
3. [manifest 规范](#3-manifest-规范)
4. [页面路由](#4-页面路由)
5. [资源路径规则（最容易踩的坑）](#5-资源路径规则最容易踩的坑)
6. [宿主桥 API](#6-宿主桥-api)
7. [权限模型](#7-权限模型)
8. [KV 存储](#8-kv-存储)
9. [网络请求（代理）](#9-网络请求代理)
10. [支付](#10-支付)
11. [生命周期](#11-生命周期)
12. [打包与发布](#12-打包与发布)
13. [版本更新](#13-版本更新)
14. [调试技巧](#14-调试技巧)
15. [安全边界](#15-安全边界)
16. [常见错误速查](#16-常见错误速查)
17. [API 速查表](#17-api-速查表)

---

## 1 概述

### 1.1 什么是"小程序"

本平台的"小程序"（正式名称：**插件**）是一段**运行在沙箱 iframe 里的第三方代码**，可以：

- 读写属于你自己的 KV 存储
- 通过**宿主代理**访问白名单内的外部 HTTPS 资源
- 以用户身份发消息（需权限）
- 发起积分支付请求（需用户逐次确认）
- 关闭自己，回到聊天界面

### 1.2 沙箱模型

| 维度 | 值 | 说明 |
|---|---|---|
| iframe 属性 | `sandbox="allow-scripts"` | **不给** `allow-same-origin` |
| 文档源 | 不透明（"null"） | 拿不到宿主的 cookie / localStorage / DOM |
| 网络 | `connect-src 'none'` | 不能直接 `fetch`，必须走代理 |
| 存储 | 只能通过宿主 KV | `localStorage` / `sessionStorage` 会抛 `SecurityError` |
| 与宿主通信 | 只走 `postMessage` | 由 `window.hostAPI` 封装 |

**结论**：插件**必须**把所有"需要资源访问"的动作交给 `hostAPI`。想自己 `fetch` / `localStorage` 都会失败。

### 1.3 支持的浏览器

沙箱 iframe 与现代浏览器一致：Chrome / Edge / Firefox / Safari 的最近两个大版本。**不支持 IE**。

---

## 2 项目结构

### 2.1 目录约定

```
<plugin-id>/
├── manifest.json              ← 必需，插件元数据
├── pages/                     ← 页面目录（约定，非强制）
│   ├── index/
│   │   ├── index.html         ← 页面 HTML
│   │   ├── index.css          （可选）
│   │   └── index.js           （可选）
│   └── settings/
│       ├── settings.html
│       ├── settings.css
│       └── settings.js
└── lib/                       （可选）共享模块
    ├── host.js
    ├── config.js
    └── ...
```

**强制要求**：
- `manifest.json` 必须存在
- `manifest.entry` 指向的 HTML 必须存在
- `manifest.pages` 里列的每个路径都必须存在

**不强制**：
- 目录层级（可以不用 `pages/` 前缀）
- 文件拆分粒度（可以单页单文件，也可以多页多 lib）
- 命名（除 `manifest.json` 外）

### 2.2 文件数量与大小限制

| 限制 | 默认值 | 配置项 |
|---|---|---|
| 插件包总体积 | 5 MB | `plugins.max_bundle_bytes` |
| 单文件体积 | 1 MB | `plugins.max_file_bytes` |
| 文件数量 | 100 | `plugins.max_files_per_plugin` |
| 每用户可发布插件数 | 20 | `plugins.max_published_per_user` |

超过限制的上传会被拒，并给出明确错误。

### 2.3 忽略的文件

打包脚本会**自动跳过**：
- `node_modules/`、`.git/`、`.svn/`、`.hg/`
- `.DS_Store`、`Thumbs.db`
- `.idea/`、`.vscode/`
- `*.swp`、`*.swx`、`*.tmp`、`*.log`、`*~`

因此你不用手动清理，但把构建产物留在源码目录里（如 `dist/`）**会被打进包**，注意检查。

---

## 3 manifest 规范

### 3.1 完整示例

```json
{
  "id": "ai-chat",
  "name": "AI 助手",
  "version": "3.0.0",
  "description": "接入 miaoda AI 助手，支持多轮对话、真流式输出",
  "entry": "pages/chat/index.html",
  "pages": [
    { "path": "pages/chat/index.html", "title": "AI 助手" },
    { "path": "pages/settings/settings.html", "title": "设置" }
  ],
  "permissions": ["ui:close", "storage"],
  "maxPayment": 500,
  "compatibility": {
    "hostFeatures": ["proxy-stream"],
    "minHostVersion": 3
  }
}
```

### 3.2 字段说明

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | string | 插件唯一标识。**2-32 位，小写字母开头，只含小写字母/数字/连字符**（正则 `^[a-z][a-z0-9-]{1,31}$`） |
| `name` | ✅ | string | 显示名称，1-40 字符 |
| `version` | ✅ | string | 语义版本 `x.y.z`（正则 `^\d+\.\d+\.\d+$`） |
| `description` | ❌ | string | 描述，最长 500 字符 |
| `entry` | ✅ | string | 入口页面（相对路径，`.html` 结尾），**必须出现在 `pages` 里** |
| `pages` | ❌ | array | 页面列表（详见 3.3）。不写时用 `entry` 推导单页 |
| `permissions` | ❌ | array | 权限列表（详见第 7 节）。最多 20 项 |
| `maxPayment` | ❌ | integer | 单笔支付上限（需 `payment:request` 权限）。≤ `plugins.payment.max_single` |
| `compatibility` | ❌ | object | 兼容性声明（保留字段，暂不强制校验） |
| `proxy` | ❌ | array | **已废弃**。白名单由 `server/plugin-whitelist.yaml` 管理，此字段被忽略 |

### 3.3 pages 字段

两种写法（混用不推荐）：

```json
// 写法 1：字符串数组
"pages": [
  "pages/index/index.html",
  "pages/settings/settings.html"
]

// 写法 2：对象数组（可带 title）
"pages": [
  { "path": "pages/index/index.html", "title": "首页" },
  { "path": "pages/settings/settings.html", "title": "设置" }
]
```

**规则**：
- 每个 `path` 必须是 `.html` / `.htm` 结尾
- 每个 `path` 必须是安全相对路径（不含 `..`、不以 `/` 开头）
- 路径不能重复
- `entry` 必须出现在这个列表里
- 最多 50 页

**title 的作用**：会**覆盖** HTML 里原本的 `<title>`。用于多页时统一管理页面标题。

### 3.4 permissions 白名单

只允许出现以下值，其它一律拒绝（防止声明了权限但宿主不认）：

| 权限 key | 说明 |
|---|---|
| `user:read` | 读取当前用户的 id / nickname / avatar |
| `user:friends` | 读取好友列表（id / nickname / avatar） |
| `room:list` | 读取会话列表（不含消息内容） |
| `message:send` | 以用户身份发消息 |
| `storage` | 读写自己的 KV 存储 |
| `ui:toast` | 弹出宿主通知 |
| `ui:close` | 关闭自己，返回宿主 |

**未声明的权限，插件调不动**。安装时用户还能**逐项取消勾选**——取消的权限，即使 manifest 声明了，也会被拒绝。

**作者豁免**：插件作者在调试自己插件时，权限检查被跳过（但 manifest 声明的权限列表本身仍会校验）。

---

## 4 页面路由

### 4.1 单页 vs 多页

- **单页**：不写 `pages`，只写 `entry`。宿主把它当只有一个页面。
- **多页**：写 `pages`，通过 `hostAPI.navigate` 在页面间跳转。

多页在以下场景有用：
- 主功能页 + 设置页
- 列表页 + 详情页
- 新手引导页 + 主功能页

### 4.2 跳转 API

```js
// 打开新页面（进栈）
await window.hostAPI.navigate({
  type: 'to',
  path: 'pages/settings/settings.html',
  params: { from: 'chat' }
});

// 返回上一页（出栈）
await window.hostAPI.navigate({ type: 'back' });

// 替换当前页（不增加栈深）
await window.hostAPI.navigate({
  type: 'redirect',
  path: 'pages/other.html'
});
```

**`type` 语义**：

| type | 行为 | 对应微信小程序 |
|---|---|---|
| `to` | 打开新页，进栈 | `wx.navigateTo` |
| `back` | 出栈，栈深 1 时等价于关闭插件 | `wx.navigateBack` |
| `redirect` | 替换栈顶（当前页被销毁） | `wx.redirectTo` |

### 4.3 读取页面入参

跳转时传的 `params` 通过 `getLaunchParams()` 读取：

```js
// 页面 A 跳转
await hostAPI.navigate({
  type: 'to',
  path: 'pages/settings/settings.html',
  params: { from: 'chat', timestamp: Date.now() }
});

// 页面 B（settings.js）读取
const params = hostAPI.getLaunchParams();
console.log(params.from);       // 'chat'
console.log(params.timestamp);  // 1712345678901
```

**注意**：
- `params` 序列化后放进 URL 的 `?__params=` 查询串，**会暴露在 URL 里**
- 不要放敏感数据
- 值类型建议只用 `string` / `number` / `boolean` / 简单数组/对象（JSON 序列化无损）

### 4.4 页面栈

```js
// 获取当前页面栈
const pages = await hostAPI.getCurrentPages();
// → [{ path: 'pages/chat/index.html', params: {} },
//    { path: 'pages/settings/settings.html', params: { from: 'chat' } }]
```

- 栈**不会持久化**。用户关闭插件再打开，栈重置为只有首页。
- 栈深没有硬上限，但最多几十层就没意义了。
- **每个页面是独立的 iframe 文档**。切页时整个 iframe 会重建 —— 页面的 JS 状态**会丢失**。要跨页保留数据，用 KV 存储。

### 4.5 页面生命周期

```js
// 页面进入前台（从别的页面返回，或本页刚打开）
hostAPI.onPageShow((params) => {
  console.log('页面显示，参数：', params);
  // 适合刷新数据
});

// 页面离开前台（跳转到别的页面）
hostAPI.onPageHide((params) => {
  console.log('页面隐藏');
  // 适合保存草稿
});
```

**注意**：当前实现里切页会**销毁旧 iframe**，因此 `onPageHide` **不一定被调用**。要可靠保存，用 `beforeunload`：

```js
window.addEventListener('beforeunload', () => {
  // 这里的异步操作不一定完成（浏览器不等待）
  // 想可靠保存，改成同步写入 KV（不可能，KV 是异步的）
  // 唯一可靠方案：每次数据变化都及时 save
});
```

**结论**：**不要依赖页面卸载时保存**。数据变化时立刻持久化（用防抖）。

---

## 5 资源路径规则（最容易踩的坑）

### 5.1 `<base>` 机制

服务端返回页面 HTML 时，会在 `<head>` **最开头**注入：

```html
<base href="/api/plugins/<你的插件 id>/a/<一次性 ticket>/">
```

这个 `<base>` 让页面里**所有相对 URL** 都以它为前缀。效果：

```html
<!-- 页面在 pages/chat/index.html，写： -->
<link rel="stylesheet" href="pages/chat/index.css">
<!-- 浏览器实际请求： -->
<!-- /api/plugins/ai-chat/a/<ticket>/pages/chat/index.css -->
```

### 5.2 **致命陷阱**：相对路径从"资源根"算

不是从**当前 HTML 文件所在目录**算。

**错误写法**（习惯性写成"相对当前文件"）：

```html
<!-- pages/chat/index.html -->
<link rel="stylesheet" href="index.css">
<!-- ❌ 解析成 /a/<ticket>/index.css → 404 -->
```

**正确写法**（从资源根算，路径 = 目录结构里的完整相对路径）：

```html
<!-- pages/chat/index.html -->
<link rel="stylesheet" href="pages/chat/index.css">
<!-- ✅ 解析成 /a/<ticket>/pages/chat/index.css -->
```

**记忆方法**：把 `<base href>` 之后的那一段想成"从项目根出发的完整路径"，**跟 HTML 文件自己在哪无关**。

### 5.3 各种引用方式的行为

| 引用方式 | 受 `<base>` 影响 | 正确示例 |
|---|---|---|
| HTML `<link href>` | ✅ 相对 base 解析 | `href="pages/chat/index.css"` |
| HTML `<script src>` | ✅ 相对 base 解析 | `src="lib/host.js"` |
| HTML `<img src>` | ✅ 相对 base 解析 | `src="assets/logo.png"` |
| HTML `<a href>` | ✅ 相对 base 解析 | `href="pages/about/about.html"`（但更推荐用 `hostAPI.navigate`） |
| HTML `<iframe src>` | ✅ 相对 base 解析 | 一般不用 |
| CSS `url(...)` | ❌ 相对**CSS 文件自己** | CSS 在 `pages/chat/` 里，`url(logo.png)` → `pages/chat/logo.png` |
| JS `fetch('x')` | ❌ 相对**当前页面 URL** | 用 `new URL('x', document.baseURI).href` 得到绝对 URL |
| 以 `/` 开头 | ❌ 相对域名根 | 一般不用（会绕过 ticket） |
| `http(s)://` 全 URL | ❌ 保持不变 | 用 CDN 资源，但会被 CSP 拦 |

### 5.4 JS 里正确拼资源 URL

```js
// ✅ 用 baseURI 拼出绝对 URL
const url = new URL('lib/config.json', document.baseURI).href;
// → /api/plugins/ai-chat/a/<ticket>/lib/config.json
const data = await fetch(url).then((r) => r.json());
```

**但**：`fetch` 走 `/a/` 通道会被 CSP `connect-src 'none'` 拦（`fetch` 属于 connect-src）。

**结论**：JS 里**不要 fetch 静态资源**。静态资源只在 HTML 里直接引用。

需要动态数据（如配置、JSON）时：
- 打包进 `.plugin` 的 JSON 文件 → 用 HTML 里 `<script src="data.json">` 不行（不是合法 JS）
- **推荐**：把 JSON 写进 `.js` 文件，用 `<script src="lib/config-data.js">` 加载
  ```js
  // lib/config-data.js
  window.AIChat = window.AIChat || {};
  window.AIChat.configData = { /* ... */ };
  ```
- 或**推荐**：走 KV 存储（用户配置）或代理请求（远端数据）

### 5.5 CSP 白名单

服务端返回页面的 CSP：

```
default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: <请求的 origin>;
script-src  同上;
style-src   同上;
img-src     同上;
media-src   同上;
font-src    同上;
connect-src 'none';
form-action 'none';
frame-ancestors 'self';
base-uri 'self' <请求的 origin>;
```

**放行**：
- 同源（`'self'` + 动态 `origin`）：可以加载 `/a/<ticket>/*` 的所有文件
- `'unsafe-inline'` / `'unsafe-eval'`：允许内联脚本和 `eval`（某些打包工具需要）
- `data:` / `blob:`：允许 base64 图片、Blob URL

**拦截**：
- `connect-src 'none'`：**不能 fetch / XHR / WebSocket**。要网络必须走 `hostAPI.stream` / `hostAPI.call('proxy.fetch')`
- `form-action 'none'`：不能提交表单
- 外部域名：除宿主 origin 外的一切外部资源都拦（避免外链追踪）

---

## 6 宿主桥 API

### 6.1 桥脚本来源

桥脚本由**服务端**在返回页面 HTML 时**内联注入**到 `<head>`，定义 `window.hostAPI`。

```js
// 检查桥是否就绪
if (window.hostAPI && typeof window.hostAPI.call === 'function') {
  console.log('桥版本：', window.hostAPI.version);   // 3
}
```

**为什么由服务端注入**：沙箱 iframe 不给 `allow-same-origin`，宿主拿不到 `contentDocument`，无法从客户端侧注入 `<script>`。

### 6.2 hostAPI.version

| 版本 | 新增能力 |
|---|---|
| 1 | `call`（请求-响应） |
| 2 | `stream`（真流式） |
| 3 | `navigate` / `getCurrentPages` / `getLaunchParams` / `onPageShow` / `onPageHide` |

### 6.3 hostAPI.call(method, args)

请求-响应式调用。返回 Promise。

```js
const result = await window.hostAPI.call('storage.get', { key: 'my-key' });
```

所有 `call` 都有 **30 秒超时**。超时后 reject，消息为 `宿主响应超时（<method>）`。

**可用的 method 列表**见第 17 节。

### 6.4 hostAPI.stream(url, opts)

**真流式** HTTP 请求。返回 `AsyncIterable<chunk: string>`。

```js
const iterable = window.hostAPI.stream('https://api.example.com/chat', {
  method: 'POST',
  headers: {
    'accept': 'text/event-stream',
    'authorization': 'Bearer xxx',
    'content-type': 'application/json'
  },
  body: JSON.stringify({ messages: [...] })
});

// 手动迭代（兼容性好）
const iter = iterable[Symbol.asyncIterator]();
while (true) {
  const { value, done } = await iter.next();
  if (done) break;
  console.log('收到数据块：', value);   // 是 string
}

// 或 for-await（现代浏览器）
for await (const chunk of iterable) {
  console.log(chunk);
}
```

**提前终止**：

```js
let cancelled = false;
for await (const chunk of iterable) {
  if (cancelled) {
    // 不需要显式 break —— for-await 会自动调用 iterator.return()
    // 桥会通知宿主取消上游 HTTP 请求
    break;
  }
  console.log(chunk);
}
```

**约束**：
- URL 的 origin 必须在该插件白名单里（见第 9 节）
- 请求体上限 128 KB
- 只允许 GET / POST
- 只转发白名单请求头：`authorization` / `content-type` / `accept` / `x-api-key`
- 上游响应**不缓存**（与 `proxy.fetch` 不同）

### 6.5 hostAPI.navigate(opts)

见第 4 节。

### 6.6 hostAPI.getCurrentPages()

见第 4 节。

### 6.7 hostAPI.getLaunchParams()

见第 4 节。

### 6.8 hostAPI.onPageShow / onPageHide

见第 4 节。

---

## 7 权限模型

### 7.1 声明与授权

- **声明**：写在 `manifest.permissions`
- **授权**：用户**安装**时逐项确认（可取消勾选）
- **使用**：每次调用 `hostAPI.call` 时**重查**用户实际批准的权限

**关键点**：声明了 ≠ 授权了。如果用户取消勾选 `storage`，插件调 `storage.get` 会收到 `缺少权限：storage`。

### 7.2 权限检查时机

- 每次 `hostAPI.call('xxx.yyy')` 都检查一次
- 用户的授权状态在服务端 `/user_plugins.granted_perms` 列里
- **没有缓存**，改授权立即生效（不用重装）

### 7.3 作者豁免

插件**作者**在调试自己插件时，跳过权限检查。用于简化开发流程。

**但**：manifest 里没声明的权限，作者**也不能调**（会收到 `未知方法`）。

---

## 8 KV 存储

### 8.1 是什么

每个 `(插件 × 用户)` 一份**隔离的键值存储**。

- 插件 A 的 KV 和插件 B 的 KV 隔离
- 用户 1 的 KV 和用户 2 的 KV 隔离
- 只能存字符串（value 必须转成 string）

### 8.2 配额

| 项 | 默认值 | 配置项 |
|---|---|---|
| 每 (插件 × 用户) 总量 | 100 KB | `plugins.kv_quota_bytes` |
| 单 value | 16 KB | `plugins.kv_value_max_bytes` |

超限返回 `插件存储配额不足（102400 字节）`。

### 8.3 API

```js
// 读单个 key
const { value } = await window.hostAPI.call('storage.get', { key: 'user-config' });

// 写（覆盖）
await window.hostAPI.call('storage.set', { key: 'user-config', value: JSON.stringify({...}) });

// 删
await window.hostAPI.call('storage.remove', { key: 'user-config' });

// 列表 + 用量
const { items, usage } = await window.hostAPI.call('storage.list');
// items: [{ key, value }, ...]
// usage: { used, count, quota }
```

### 8.4 最佳实践

**存对象要序列化**：

```js
// 存
const config = { model: 'gpt-4', temperature: 0.7 };
await hostAPI.call('storage.set', {
  key: 'config',
  value: JSON.stringify(config)
});

// 读
const { value } = await hostAPI.call('storage.get', { key: 'config' });
const config = value ? JSON.parse(value) : { model: 'gpt-4', temperature: 0.7 };
```

**处理 JSON 解析失败**：

```js
let config = DEFAULTS;
try {
  const { value } = await hostAPI.call('storage.get', { key: 'config' });
  if (value) config = JSON.parse(value);
} catch (e) {
  // KV 读失败 or JSON 解析失败 → 用默认值
  console.warn('读取配置失败：', e.message);
}
```

**防抖写入**（避免频繁调用宿主）：

```js
let saveTimer = null;
function scheduleSave(data) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await hostAPI.call('storage.set', {
      key: 'data',
      value: JSON.stringify(data)
    });
  }, 1000);   // 1 秒内的多次调用合并成一次
}
```

**限制列表长度**（防止 KV 撑爆）：

```js
// 存会话列表时，只保留最近 60 个
const toSave = conversations.slice(0, 60);
await hostAPI.call('storage.set', {
  key: 'conversations',
  value: JSON.stringify(toSave)
});
```

---

## 9 网络请求（代理）

### 9.1 为什么需要代理

沙箱 iframe 的两个限制：

1. **CSP `connect-src 'none'`** —— 禁止 `fetch` / `XHR` / `WebSocket`
2. **不透明源 + 同源策略** —— 即使放宽 CSP，跨源请求也会被浏览器的 CORS 拦

**唯一的出路**：让**宿主**替插件发请求。

### 9.2 白名单配置

**由运维**（不是插件作者）在 `server/plugin-whitelist.yaml` 里配置：

```yaml
ai-chat:
  - https://backend.miaoda.online

weather-plugin:
  - https://api.openweathermap.org
  - https://cdn.example.com
```

**约束**：
- 只允许 `https://`（不接受 `http://`，避免降级）
- 只允许 `origin`（不能带路径 / query / fragment）
- 不允许带认证信息（`user:pass@`）
- 不支持通配符（`*.example.com` 会被跳过）
- 每个插件最多 10 条
- 文件改动后**热重载**，无需重启

### 9.3 一次性请求（proxy.fetch）

适合：普通 REST API、能一次性拿到响应的场景。

```js
const result = await window.hostAPI.call('proxy.fetch', {
  url: 'https://api.example.com/data',
  method: 'GET',
  headers: {
    'authorization': 'Bearer xxx'
  }
  // 或 POST + body：
  // body: JSON.stringify({ q: 'x' })
});

// result = { status, contentType, body, cached }
console.log(result.status);       // 200
console.log(result.body);         // 响应文本（string）
console.log(result.cached);       // 是否命中服务端缓存
```

**特性**：
- 有服务端缓存（5 分钟 TTL，仅 GET）
- 响应体上限 2 MB
- 不跟随重定向

### 9.4 流式请求（stream）

适合：SSE、大响应、需要实时处理的场景。

```js
const iterable = window.hostAPI.stream('https://api.example.com/chat', {
  method: 'POST',
  headers: {
    'accept': 'text/event-stream',
    'authorization': 'Bearer xxx',
    'content-type': 'application/json'
  },
  body: JSON.stringify({ messages: [...] })
});

// 逐块处理
for await (const chunk of iterable) {
  console.log(chunk);
}
```

**特性**：
- **不缓存**（每次都真实请求上游）
- **响应体无上限**
- **真正的流式** —— 上游推一块，插件收一块
- 插件提前 `break` → 通知宿主取消上游 HTTP 请求（释放并发槽位）

### 9.5 请求头白名单

只有这些请求头会被**转发**到上游：

| 请求头 | 说明 |
|---|---|
| `authorization` | Bearer / Basic 认证 |
| `content-type` | POST 请求体类型 |
| `accept` | 期望的响应类型 |
| `x-api-key` | API Key 认证 |

**其它请求头会被静默丢弃**。这是防止插件通过代理伪造任意请求头（比如伪装 `X-Forwarded-For`）。

### 9.6 安全约束

- `url` 的 origin **必须**在插件白名单里。服务端会**再次校验**。
- 服务端 `redirect: 'manual'` —— 上游返回重定向一律报错（防绕白名单）。
- 每次请求会经过服务端并发控制（同时最多 2 个），队列上限 10。

---

## 10 支付

### 10.1 前置条件

- manifest 声明 `payment:request` 权限
- 用户在安装时**批准**了该权限
- manifest 可声明 `maxPayment`（单笔上限），不声明则用平台默认

### 10.2 支付流程

```js
try {
  const result = await window.hostAPI.call('payment.request', {
    amount: 100,
    subject: '解锁专业版',
    orderId: 'order-2026-001',   // 幂等键：同一 orderId 只扣一次
    metadata: { level: 2 }
  });

  if (result.ok) {
    console.log('支付成功，交易 ID：', result.transactionId);
    console.log('当前余额：', result.balance);
    console.log('是否已支付过：', result.alreadyPaid);
  } else if (result.error === 'user_cancelled') {
    console.log('用户取消');
  } else {
    console.log('支付失败：', result.error);
  }
} catch (err) {
  console.error('支付异常：', err.message);
}
```

### 10.3 宿主侧的行为

**用户在宿主对话框里点击"确认支付"之前，插件拿不到任何结果**。这是关键安全设计：

- 插件**不能**伪造"用户已确认"
- 插件**不能**篡改金额（宿主显示的金额来自服务端，不是插件传的）
- 插件**不能**在 UI 上把"取消"按钮画成"确认"（对话框是宿主的 DOM）

### 10.4 每日限制

- 服务端对**每个用户 × 每个插件**有每日支付笔数上限（默认 100 笔）
- 退款不减笔数（防止"支付→退款→再支付"循环）
- 超限返回 `今日对该插件的支付次数已达上限`

### 10.5 幂等

同一 `orderId` 重复调用：

- **首次**：正常扣款
- **再次**：返回 `alreadyPaid: true`，**不重复扣款**
- **退款后再次**：拒绝（`该订单已退款，如需再次购买请使用新的 orderId`）

**结论**：`orderId` 要能唯一标识"这一次购买意图"。用户重试时用同一个，用户想再买一次时用新的。

---

## 11 生命周期

### 11.1 打开插件

```
用户点击插件
  ↓
前端请求 /api/plugins/:id/ticket   （申请票据）
  ↓
服务端校验安装状态 → 签发票据（60 秒有效）
  ↓
前端创建 iframe，src = /api/plugins/:id/p/<ticket>/pages/index/index.html
  ↓
服务端读 HTML + 注入 <base> + 桥脚本 + title
  ↓
iframe 加载，桥脚本执行，window.hostAPI 可用
  ↓
页面 JS 开始执行
```

### 11.2 关闭插件

```
用户点击"返回"或"关闭"
  ↓
宿主移除 iframe（DOM 卸载）
  ↓
（延迟 300ms）宿主请求 DELETE /api/plugins/:id/ticket  （撤销票据）
```

**注意**：iframe 卸载时页面的 `beforeunload` / `unload` **不保证被调用**。不要依赖它做清理。

### 11.3 切换页面（多页）

```
用户点击"跳转"
  ↓
页面调用 hostAPI.navigate(...)
  ↓
宿主更新 pageStack → iframe 的 key 变化 → **旧 iframe 销毁，新 iframe 创建**
  ↓
新页面加载，window.hostAPI 重新初始化
  ↓
旧页面的 JS 状态**完全丢失**
```

**跨页保留状态的唯一方式**：KV 存储（异步，需要提前写入）。

### 11.4 刷新插件

用户点"重新加载"：

```
宿主请求新的 ticket → iframe 的 src 变化 → 重建 iframe
```

页面的所有内存状态丢失。

---

## 12 打包与发布

### 12.1 打包工具

`plugins-demo/pack-plugin.mjs`（通用打包脚本）：

```bash
cd plugins-demo
node pack-plugin.mjs <插件目录名>
```

**做了什么**：
1. 读 `<插件目录>/manifest.json`
2. 递归收集目录下所有文件（除 manifest.json、忽略 `.git` / `node_modules` / `*.tmp` 等）
3. 校验 `entry` 和 `pages` 指向的文件都存在
4. 校验每个文件 < 1 MB
5. 输出 `<插件目录名>.plugin` 到当前目录

**输出**：

```
✓ ai-chat.plugin  (48.3 KB, 11 个文件, v3.0.0)
    · lib/config.js
    · lib/host.js
    · ...
打包完成：1/1
```

### 12.2 上传

浏览器 → 侧边栏 → 插件 → 「+ 上传」：

1. 选择 `<插件目录名>.plugin`
2. （可选）上传图标
3. （可选）填更新说明
4. 选择可见性（私有 / 公开）
5. 点「上传」

**首次上传**：创建插件。
**再次上传同 id**：更新插件（自动归档旧版）。

### 12.3 可见性

| 可见性 | 谁能看到 |
|---|---|
| **私有** | 只有作者能安装、打开 |
| **公开** | 所有用户能在「发现」列表看到并安装 |

**生成分享码**：私有插件也能分享给特定用户（通过分享码订阅）。

---

## 13 版本更新

### 13.1 更新流程

```
改代码
  ↓
改 manifest.version（必须 ≥ 当前版本）
  ↓
node pack-plugin.mjs ai-chat
  ↓
浏览器上传新 .plugin
```

### 13.2 版本号规则

- 必须 `x.y.z` 格式（三位数字）
- 新版本必须 **≥** 当前版本
- **不允许倒退**（想"回滚"必须先改代码再上传新版）

### 13.3 服务端自动做的

| 时机 | 动作 |
|---|---|
| 上传前 | 校验 version ≥ 当前；被 delist/hide 的插件**拒绝** |
| 落盘 | 写新版本到临时目录 |
| 归档 | 把**当前**版本复制到 `.history/<id>/<旧版本>/`，写 `plugin_versions` 表 |
| DB | 更新 `plugins.version` / `manifest` / `updated_at` |
| 目录切换 | 原子 `rename` |
| 广播 | 给所有已安装用户发 `plugin:updated` socket 事件 |

### 13.4 已装用户看到什么

- **正在用插件**（iframe 已打开）：**不受影响**，继续用旧版；下次打开走新版
- **在插件列表页**：卡片显示"更新"角标 + 版本号更新
- **查看插件详情**：能看到「版本历史」（含旧版本 + changelog）

### 13.5 版本历史

在插件详情对话框里展示：

```
版本历史
v3.0.0                                    2026-10-03 14:32
修复了 XXX，新增了 YYY
```

这是**旧版本**的归档记录。当前版本不出现在历史里。

---

## 14 调试技巧

### 14.1 打开 iframe 的 DevTools

Chrome / Edge：
1. F12 打开 DevTools
2. 顶部「Console」标签左上角有**上下文选择器**（默认显示 `top`）
3. 选 `plugin-entry-...` 或对应的 iframe
4. 现在 Console 里执行的代码在 iframe 上下文里

可以执行：

```js
window.hostAPI          // 检查桥对象
window.hostAPI.version  // → 3
typeof window.hostAPI.stream  // → "function"
document.baseURI        // 检查 <base> 是否生效
```

### 14.2 Network 面板看资源加载

打开 DevTools → Network：

- **entry HTML**：`GET /api/plugins/<id>/p/<ticket>/pages/index/index.html`
- **CSS**：`GET /api/plugins/<id>/a/<ticket>/pages/index/index.css`
- **JS**：`GET /api/plugins/<id>/a/<ticket>/lib/host.js`

**如果 CSS/JS 的 URL 里没有 `/a/<ticket>/`**，说明 `<base>` 没生效（检查服务端是否注入了 base）。

**如果 401 / 404**，检查：
- 401：ticket 过期（60 秒）；刷新插件
- 404：文件路径错了（检查是"从资源根算"还是"从当前文件算"）

### 14.3 快速验证桥

在 iframe Console 里：

```js
// 检查版本
console.log(window.hostAPI.version);

// 检查 KV
window.hostAPI.call('storage.list').then(console.log);

// 检查白名单（会失败如果没配）
window.hostAPI.call('proxy.fetch', { url: 'https://example.com' })
  .then(console.log)
  .catch(console.error);
```

### 14.4 CSP 报错怎么办

Console 里看到：

```
Refused to load the script 'http://host/api/plugins/.../lib/host.js'
because it violates the following Content Security Policy directive:
"script-src 'self' ..."
```

**原因**：服务端没把当前 origin 加进 CSP。

**确认方法**：Network 面板 → 找 entry 响应 → Response Headers → `Content-Security-Policy` → 看 `script-src` 里有没有你访问的 origin。

**修复**：确认服务端 `setPluginContentHeaders(req, res)` 已经改成动态 origin 版本。

### 14.5 上传失败

| 错误 | 原因 | 修法 |
|---|---|---|
| `manifest.id 不合法` | id 格式不对 | 小写字母开头，只含 `a-z0-9-`，2-32 位 |
| `manifest.pages 里...不在打包文件里` | 页面 HTML 文件没打进去 | 检查目录，重新打包 |
| `manifest.entry 必须出现在 pages 里` | entry 和 pages 不一致 | 改 manifest.json |
| `文件过大` | 单文件 > 1 MB | 拆分文件，或压缩资源 |
| `插件包不能超过 XX MB` | 总体积过大 | 检查是否误打包了 node_modules 或构建产物 |
| `该插件已被管理员下架，不能重新发布` | 插件被 delist / hide | 联系管理员恢复 |
| `新版本号 X 低于当前版本 Y` | 版本号倒退 | 改成更大的版本号 |

---

## 15 安全边界

### 15.1 沙箱能保证什么

- **拿不到宿主的 cookie / localStorage**：沙箱不透明源
- **拿不到宿主的 DOM**：跨源限制
- **不能直接发网络请求**：CSP + 同源策略
- **不能直接读写宿主文件**：无 File API 权限
- **不能读取其他插件的数据**：KV 隔离

### 15.2 沙箱不能保证什么

- **截图**：用户可以看到并截图你的 UI
- **插件内的数据泄露**：你的代码在 iframe 里运行，用户可以看到它的源码（同源开发工具）
- **恶意插件在**用户批准权限后**的滥用**：用户在安装时点击"同意"，插件拿到权限后的一切行为都算用户授权

### 15.3 插件作者的责任

- **不申请不需要的权限**：只申请功能必需的
- **不在插件内隐藏后门**：不做用户不知情的数据采集
- **不绕过宿主的付费 / 限流**：走正规支付通道，不滥用 API
- **不留后门到外网**：白名单里只放功能必需的外部域名

**恶意插件会被永久封禁开发者账号。**

### 15.4 用户的自我保护

- 安装前**看权限列表**：只有必需的才勾
- 只装**信任**的插件：从分享码安装时确认来源
- 发现可疑行为 → **立即卸载** + 联系管理员

---

## 16 常见错误速查

| 报错 | 原因 | 修法 |
|---|---|---|
| `宿主响应超时（xxx）` | 桥调用超过 30 秒 | 检查宿主端逻辑 / 分页处理大数据 |
| `未知方法：xxx` | 调了不存在的 hostAPI method | 检查 method 名（见第 17 节） |
| `缺少权限：xxx` | 用户没批准该权限 | 在 manifest 声明；让用户重新安装并勾选 |
| `宿主桥未注入` | 桥脚本没注入（罕见） | 检查服务端 pluginBridgeSource.js |
| `该插件未配置 proxy 白名单` | 白名单文件里没这个插件 | 联系运维加白名单 |
| `该插件没有访问 xxx 的权限` | origin 不在白名单里 | 联系运维加 |
| `url 不合法：只允许 https` | 用了 http URL | 改 https |
| `请求体过大（>128KB）` | POST body 超限 | 分片上传，或压缩后传 |
| `插件存储配额不足` | KV 超 100 KB | 清理旧数据，或压缩存储 |
| `value 超过 16384 字节` | 单 value 超 16 KB | 拆分成多个 key |
| `连接已断开` | socket 断了 | 等重连，或检查网络 |

---

## 17 API 速查表

### 17.1 hostAPI 顶层方法

| 方法 | 说明 |
|---|---|
| `hostAPI.call(method, args)` | 请求-响应调用 |
| `hostAPI.stream(url, opts)` | 真流式请求 |
| `hostAPI.navigate(opts)` | 页面跳转 |
| `hostAPI.getCurrentPages()` | 获取页面栈 |
| `hostAPI.getLaunchParams()` | 获取本页入参 |
| `hostAPI.onPageShow(cb)` | 页面进入前台 |
| `hostAPI.onPageHide(cb)` | 页面离开前台 |
| `hostAPI.version` | 版本号 |

### 17.2 call 的 method 列表

**用户**：
| method | 权限 | 返回 |
|---|---|---|
| `user.me` | `user:read` | `{ id, nickname, avatar }` |
| `user.friends` | `user:friends` | `[{ id, nickname, avatar }]` |
| `room.list` | `room:list` | `[{ key, type, roomId, name, avatar }]` |

**消息**：
| method | 权限 | 参数 |
|---|---|---|
| `message.send` | `message:send` | `{ roomType, roomId, text }` |

**存储**：
| method | 权限 | 参数 / 返回 |
|---|---|---|
| `storage.get` | `storage` | `{ key }` → `{ key, value }` |
| `storage.set` | `storage` | `{ key, value }` → `{ key, value, usage }` |
| `storage.remove` | `storage` | `{ key }` → `{ ok: true }` |
| `storage.list` | `storage` | → `{ items, usage }` |

**UI**：
| method | 权限 | 参数 |
|---|---|---|
| `ui.toast` | `ui:toast` | `{ text }` |
| `ui.close` | 无 | —— |

**支付**：
| method | 权限 | 参数 / 返回 |
|---|---|---|
| `payment.request` | `payment:request` | `{ amount, subject, orderId, metadata? }` → `{ ok, transactionId, balance, alreadyPaid }` |

**代理**：
| method | 权限 | 参数 |
|---|---|---|
| `proxy.fetch` | 白名单 | `{ url, method?, headers?, body? }` |
| `proxy.stream.start` | 白名单 | `{ streamId, url, method?, headers?, body? }` |
| `proxy.stream.abort` | 白名单 | `{ streamId }` |

**页面**：
| method | 权限 | 参数 |
|---|---|---|
| `navigate` | 无 | `{ type, path, params? }` |
| `getCurrentPages` | 无 | —— |

### 17.3 错误码

| 错误消息 | HTTP | 含义 |
|---|---|---|
| `缺少权限：xxx` | 403 | 用户没批准该权限 |
| `该插件没有访问 xxx 的权限` | 403 | origin 不在白名单 |
| `该插件未配置 proxy 白名单` | 403 | 白名单里没这个插件 |
| `user_cancelled` | —— | 用户取消支付 |
| `宿主响应超时` | —— | 桥调用超时 |
| `未知方法：xxx` | —— | method 名拼错 |

---

## 附录 A：最小可运行示例

```
hello-world/
├── manifest.json
└── pages/
    └── index/
        ├── index.html
        ├── index.css
        └── index.js
```

**manifest.json**：

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "最小示例",
  "entry": "pages/index/index.html",
  "pages": [{ "path": "pages/index/index.html", "title": "Hello" }],
  "permissions": ["ui:close"]
}
```

**pages/index/index.html**：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello</title>
<link rel="stylesheet" href="pages/index/index.css">
</head>
<body>
<h1>Hello, World!</h1>
<button id="close">关闭插件</button>
<script src="pages/index/index.js"></script>
</body>
</html>
```

**pages/index/index.css**：

```css
body {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 20px;
}
h1 { color: #4d6bfe; }
button { padding: 8px 16px; font-size: 14px; }
```

**pages/index/index.js**：

```js
document.getElementById('close').addEventListener('click', () => {
  window.hostAPI.call('ui.close', {});
});
```

打包上传即可运行。

---

## 附录 B：相关文件

| 文件 | 用途 |
|---|---|
| `server/plugin-whitelist.yaml` | 代理白名单（运维维护） |
| `server/config.yaml` | 插件系统配置（`plugins.*`） |
| `server/src/services/pluginBridgeSource.js` | 桥脚本源（服务端权威版本） |
| `server/src/services/plugins.js` | 插件核心业务 |
| `server/src/routes/plugins.js` | HTTP 路由 |
| `client/src/utils/pluginBridge.js` | 宿主侧桥（postMessage 接收端） |
| `client/src/components/plugins/PluginHost.jsx` | iframe 宿主组件 |
| `plugins-demo/pack-plugin.mjs` | 打包脚本 |
| `server/scripts/plugin_v3_check.mjs` | 集成回归 |
| `docs/DEVLOG.md` / `ERRORLOG.md` | 宿主维护者文档 |

---

**遇到问题先看第 16 节（常见错误速查），再回来读相关章节。**

**最后更新：2026-10-03**
```

---

# 三、应用步骤

1. **替换** `client/src/components/plugins/PluginUploadDialog.jsx`（用上面的完整代码）
2. **新建** `docs/PLUGIN-GUIDE.md`（用上面的完整 md）
3. 前端重新构建：

```bash
cd D:\realtime-chat\client
npm run build
# 或 npm run dev
```

4. 硬刷新浏览器（Ctrl+Shift+R）让新组件生效
5. 打开插件页 → 点「+ 上传」→ 应看到新提示语

---

# 四、提示语做了什么改动（速览）

**旧的**（单页时代的误导）：

```
项目结构：manifest.json + index.html + style.css + app.js
```

**新的**：

```
<id>/
├── manifest.json
├── pages/<页名>/<页名>.html   ← 至少 1 个页面
├── pages/<页名>/<页名>.css    （可选）
├── pages/<页名>/<页名>.js     （可选）
└── lib/                       （可选，共享模块）
```

**新增的 4 条要点**：

- ✅ `manifest.pages` 里每个路径都要存在，`entry` 必须在 pages 里
- ✅ **相对路径从"资源根"算**（这是最容易踩的坑）
- ✅ **更新版本**：同 id 覆盖，改 `manifest.version` 增大
- ✅ 代理白名单由运维在 yaml 配（收成一行，不再单独成段）

---

# 五、守则覆盖的内容（`docs/PLUGIN-GUIDE.md`）

| 章节 | 内容 |
|---|---|
| 1 | 沙箱模型、浏览器兼容 |
| 2 | 目录结构、文件大小限制 |
| 3 | manifest 完整字段说明 |
| 4 | 多页路由（navigate / pageStack / 生命周期） |
| 5 | **资源路径规则**（`<base>` 机制 + 最大的坑 + 各种引用方式的行为表） |
| 6 | 桥 API（call / stream / navigate） |
| 7 | 权限模型（声明 ≠ 授权、作者豁免） |
| 8 | KV 存储（配额、序列化、防抖、列表截断） |
| 9 | 网络代理（白名单、fetch / stream、请求头白名单） |
| 10 | 支付（宿主确认框、幂等、每日限制） |
| 11 | 生命周期（打开 / 关闭 / 切页 / 刷新） |
| 12 | 打包与发布 |
| 13 | **版本更新**（同 id 覆盖 + 版本号规则 + 归档 + 广播） |
| 14 | 调试技巧（iframe DevTools、Network 排查、CSP 报错诊断） |
| 15 | 安全边界（沙箱保证什么、不保证什么、作者责任） |
| 16 | **常见错误速查表**（一表打尽所有报错） |
| 17 | **API 速查表**（所有 method + 权限 + 参数） |
| 附录 A | 最小可运行示例 |
| 附录 B | 相关文件索引 |

守则里最重要的两条：
- **第 5 节的资源路径规则** —— 「相对路径从资源根算」是 v3 多文件插件最容易踩的坑
- **第 16 节的错误速查表** —— 遇到报错先查这里