// client/src/utils/pluginBridge.js
//
// 宿主侧的 postMessage 桥。
//
// 插件跑在 <iframe sandbox="allow-scripts"> 里（不给 allow-same-origin），
// 与宿主是**不透明源**关系：它拿不到宿主的 DOM / cookie / localStorage，
// 也不能直接 fetch 宿主的接口。与宿主通信的唯一通道就是 postMessage。
//
// [SEC] 三道防线：
//   1. e.source === iframe.contentWindow —— 只认自己的 iframe 发来的消息，
//      否则恶意页面 / 其他 iframe 可以伪造请求
//   2. 每次 host.call 都按 **用户实际批准的权限** 重查（不信任 manifest）
//   3. 插件不可信，任何 handler 抛错都不能影响宿主 —— 全部 try/catch
//
// 桥的能力（对齐 config.yaml → plugins.allowed_permissions）：
//   user:read          user.me
//   user:friends       user.friends
//   room:list          room.list
//   message:send       message.send
//   storage            storage.get / storage.set / storage.remove / storage.list
//   ui:toast           ui.toast
//   ui:close           ui.close
//   payment:request    payment.request  ← 宿主弹确认框 → 服务端事务
//
// proxy.fetch / proxy.stream.start / proxy.stream.abort —— 代理请求：
//   · 白名单由 **server/plugin-whitelist.yaml** 管理
//   · proxy.fetch 一次性拿回完整文本（有服务端缓存）
//   · proxy.stream.* 逐块转发上游数据（供 SSE / 大响应）
//
// [NEW] navigate / getCurrentPages —— **多页面路由**：
//   · 插件侧 hostAPI.navigate({ type, path, params }) → 桥调用 'navigate' handler
//   · 宿主更新 pageStack 状态 → 触发 PluginHost 重建 iframe
//   · 页面路径必须在 manifest.pages 里（宿主校验）
//
// [CHANGED] 认证改造：不再接收 token 参数 —— 桥内部调 API 时走 api/http.js，
//   从 auth/session.js 的内存里读 Access Token。
//
// [FIX] preserve-caught-error：catch 里 re-throw 时把原异常通过 `cause`
//   挂上去（`throw new Error(msg, { cause: err })`），否则原始堆栈丢失。
//
// [CHANGED] 插件每日支付限额从"金额"改为"笔数"：
//   · 服务端 pay-info 返回 dailyCountUsed / dailyCountMax / dailyCountRemain
//   · 桥只是透传，宿主侧 PluginPayDialog 负责展示
//
// [NOTE] 桥脚本有**两份**，勿改错地方：
//   · **本文件**（客户端）= 宿主侧 createPluginBridge —— postMessage 的接收端。
//     修改 handler 表要改这里。
//   · **server/src/services/pluginBridgeSource.js**（服务端）= iframe 里
//     window.hostAPI 的定义（call / stream / navigate 方法的实现）。
//     沙箱 iframe 不给 allow-same-origin，宿主拿不到 contentDocument，
//     无法从客户端侧注入 <script>，所以那份必须由服务端在返回 HTML 时
//     内联到 <head>。
//   两份**都要改**，且都要重启 / 刷新才生效。
//
import {
  pluginKvList,
  pluginKvGet,
  pluginKvSet,
  pluginKvDel,
  payPlugin,
  getPluginPayInfo,
  fetchPluginProxy,
  fetchPluginProxyStream
} from '../api';

const REQUEST_TIMEOUT_MS = 30000;

/** 需要权限的 handler 包装器 */
function requirePerm(perm, fn) {
  return async (ctx, args) => {
    // 作者本人调试自己的插件：豁免权限检查（但 manifest 声明的权限不会绕过桥的分发）
    if (!ctx.isOwner && !ctx.grantedPerms.has(perm)) {
      const e = new Error(`缺少权限：${perm}`);
      e.code = 'PERMISSION_DENIED';
      throw e;
    }
    return fn(ctx, args);
  };
}

/** 简单参数校验工具 */
function mustString(v, name, { max = 2000, allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw new Error(`${name} 必须是字符串`);
  if (!allowEmpty && v.length === 0) throw new Error(`${name} 不能为空`);
  if (v.length > max) throw new Error(`${name} 超过 ${max} 字符`);
  return v;
}
function mustInt(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} 必须是整数`);
  if (n < min || n > max) throw new Error(`${name} 超出范围 [${min}, ${max}]`);
  return n;
}

// ============================================================
// 代理请求辅助
//
// 请求头白名单与 server/src/routes/plugins.js 的同名白名单**是双层过滤**：
// 客户端先过滤一遍（防止把无意义的头带上），服务端再过滤一遍
// （防止客户端被绕过）。两边的白名单内容必须一致。
// ============================================================
const ALLOWED_PROXY_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key']);

/** 从 iframe 传来的 args 中提取安全的请求头 */
function pickSafeHeaders(rawHeaders) {
  const out = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return out;
  for (const [k, v] of Object.entries(rawHeaders)) {
    const lk = String(k).toLowerCase();
    if (!ALLOWED_PROXY_HEADERS.has(lk)) continue;
    if (typeof v !== 'string') continue;
    out[lk] = v.slice(0, 2000);
  }
  return out;
}

/** 从 iframe 传来的 args 中提取 method / body（带长度检查） */
function pickMethodAndBody(args) {
  const method = String(args?.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  let body = null;
  if (method === 'POST' && args?.body !== undefined && args?.body !== null) {
    const b = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    if (b.length > 128 * 1024) throw new Error('请求体过大（>128KB）');
    body = b;
  }
  return { method, body };
}

/** 校验 url 在白名单里，返回 origin */
function assertProxyOrigin(url, allow) {
  let origin;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('只允许 https');
    origin = u.origin;
  } catch (err) {
    throw new Error(`url 不合法：${err.message}`, { cause: err });
  }
  if (!allow.includes(origin)) {
    throw new Error(`该插件没有访问 ${origin} 的权限`);
  }
  return origin;
}

// ============================================================
// 桥方法表
// ============================================================
function buildHandlers() {
  return {
    // ---------- 用户 ----------
    'user.me': requirePerm('user:read', (ctx) => ({
      id: ctx.user.id,
      nickname: ctx.user.nickname,
      avatar: ctx.user.avatar || ''
    })),

    'user.friends': requirePerm('user:friends', (ctx) => {
      // 前端不缓存好友列表的地方就用 socket 里带的
      return (ctx.friends || []).map((f) => ({
        id: f.id, nickname: f.nickname, avatar: f.avatar || ''
      }));
    }),

    // ---------- 房间 ----------
    'room.list': requirePerm('room:list', (ctx) => {
      return (ctx.rooms || []).map((r) => ({
        key: r.key, type: r.type, roomId: r.roomId,
        name: r.name, avatar: r.avatar || ''
        // 不含 lastMessage（消息内容需要额外权限，暂未开放）
      }));
    }),

    // ---------- 发消息 ----------
    'message.send': requirePerm('message:send', (ctx, args) => {
      const roomType = mustString(args?.roomType, 'roomType', { max: 16 });
      if (!['public', 'private', 'group'].includes(roomType)) {
        throw new Error('roomType 只支持 public / private / group');
      }
      const roomId = mustString(args?.roomId, 'roomId', { max: 64 });
      const text = mustString(args?.text || '', 'text', { max: 2000, allowEmpty: true });

      if (!text.trim()) throw new Error('消息内容不能为空');

      if (typeof ctx.onSendMessage !== 'function') {
        throw new Error('宿主未提供发送通道');
      }
      ctx.onSendMessage({
        roomType,
        roomId,
        text,
        fileUrl: null,
        fileName: null,
        fileType: null,
        fileSize: null,
        isSticker: false,
        stickerPackId: null
      });
      return { ok: true };
    }),

    // ---------- KV ----------
    'storage.get': requirePerm('storage', async (ctx, args) => {
      const key = mustString(args?.key, 'key', { max: 128 });
      const v = await pluginKvGet(ctx.pluginId, key);
      return { key, value: v };
    }),

    'storage.set': requirePerm('storage', async (ctx, args) => {
      const key = mustString(args?.key, 'key', { max: 128 });
      const value = mustString(String(args?.value ?? ''), 'value', { max: 16384, allowEmpty: true });
      const out = await pluginKvSet(ctx.pluginId, key, value);
      return { key, value, usage: out?.usage || null };
    }),

    'storage.remove': requirePerm('storage', async (ctx, args) => {
      const key = mustString(args?.key, 'key', { max: 128 });
      await pluginKvDel(ctx.pluginId, key);
      return { ok: true };
    }),

    'storage.list': requirePerm('storage', async (ctx) => {
      const d = await pluginKvList(ctx.pluginId);
      return {
        items: (d.items || []).map((i) => ({ key: i.key, value: i.value })),
        usage: d.usage || null
      };
    }),

    // ---------- UI ----------
    'ui.toast': requirePerm('ui:toast', (ctx, args) => {
      const text = mustString(args?.text, 'text', { max: 200 });
      if (typeof ctx.onToast === 'function') ctx.onToast(text);
      return { ok: true };
    }),

    // ui.close 不需要权限：插件总是有权关闭自己
    'ui.close': async (ctx) => {
      if (typeof ctx.onClose === 'function') ctx.onClose();
      return { ok: true };
    },

    // ---------- 支付 ----------
    'payment.request': requirePerm('payment:request', async (ctx, args) => {
      const amount = mustInt(args?.amount, 'amount', { min: 1 });
      const subject = mustString(args?.subject, 'subject', { max: 60 });
      const orderId = mustString(args?.orderId, 'orderId', { max: 64 });
      const metadata = args?.metadata;

      if (typeof ctx.onPayment !== 'function') {
        throw new Error('宿主未提供支付通道');
      }

      // 1) 宿主先查一下 pay-info（拿到上限 / 余额 / 校验结果）
      let info;
      try {
        info = await getPluginPayInfo(ctx.pluginId, amount);
      } catch (err) {
        // [FIX] preserve-caught-error 规则要求 re-throw 时把原异常挂到 cause，
        //   否则原始堆栈丢失（排查时只能看到一层包装后的消息）。
        throw new Error(`查询支付信息失败：${err.message}`, { cause: err });
      }
      if (!info.valid) {
        return { ok: false, error: info.reason || '支付条件不满足', info };
      }

      // 2) 宿主侧弹确认框（用户点"确认"才继续）
      //
      // [CHANGED] 从"每日金额剩余"改为"每日笔数"三件套：
      //   · 原 dailyRemain（积分）已被后端删除
      //   · PluginPayDialog 现在读 dailyCountUsed / dailyCountMax / dailyCountRemain
      const confirmed = await ctx.onPayment({
        pluginId: ctx.pluginId,
        pluginName: info.pluginName,
        amount,
        subject,
        balance: info.balance,
        singleMax: info.singleMax,
        dailyCountUsed: info.dailyCountUsed,
        dailyCountMax: info.dailyCountMax,
        dailyCountRemain: info.dailyCountRemain
      });
      if (!confirmed) {
        return { ok: false, error: 'user_cancelled' };
      }

      // 3) 服务端事务
      try {
        const out = await payPlugin({
          pluginId: ctx.pluginId,
          amount,
          subject,
          orderId,
          metadata
        });
        return {
          ok: true,
          transactionId: out?.payment?.transactionId || null,
          balance: out?.balance ?? null,
          alreadyPaid: !!out?.alreadyPaid
        };
      } catch (err) {
        return { ok: false, error: err.message || '支付失败' };
      }
    }),

    // ---------- 代理请求（一次性） ----------
    //
    // [SEC] 权限来自**白名单**（server/plugin-whitelist.yaml），不是用户的 grantedPerms。
    //   · ctx.proxyAllow 由 PluginHost 从 plugin.proxy 读出（DTO 已从 yaml 读）
    //   · 非空才允许这个 handler 被调用
    //   · 目标 URL 的 origin 必须精确匹配白名单里的一项（服务端还会再校验）
    //
    //   不做"通配符匹配" —— 白名单是精确 origin，不给 *.example.com 这种面子。
    //   不做"跟随重定向" —— 服务端 fetch 时用的是 redirect: 'manual'，防绕白名单。
    'proxy.fetch': async (ctx, args) => {
      const allow = Array.isArray(ctx.proxyAllow) ? ctx.proxyAllow : [];
      if (allow.length === 0) {
        throw new Error('该插件未配置 proxy 白名单（请在 server/plugin-whitelist.yaml 添加）');
      }

      const url = mustString(args?.url, 'url', { max: 2000 });
      const { method, body } = pickMethodAndBody(args);
      const safeHeaders = pickSafeHeaders(args?.headers);

      // 客户端先做一次 origin 校验（提前给插件清晰报错，也少打服务端一次）
      assertProxyOrigin(url, allow);

      // 真正交给服务端代理
      try {
        return await fetchPluginProxy(ctx.pluginId, { url, method, headers: safeHeaders, body });
      } catch (err) {
        throw new Error(`代理请求失败：${err.message}`, { cause: err });
      }
    },

    // ---------- 代理请求（流式） ----------
    //
    // 与 proxy.fetch 的区别：
    //   · 不缓存
    //   · 逐块通过 postMessage 推给 iframe
    //   · 结束 / 出错 / 取消分别用 host.stream.end / host.stream.error / abort 处理
    //
    // 流程（从 iframe 侧看）：
    //   1) 插件调用 hostAPI.stream(url, opts) → 生成 streamId → host.call
    //   2) 宿主（本 handler）建立到 /plugins/:id/proxy/stream 的请求
    //   3) 逐块 read → postMessage({ type:'host.stream.chunk', streamId, chunk })
    //   4) 结束 / 出错 → 相应的消息
    //   5) 插件提前 break → 'proxy.stream.abort' → 取消上游 HTTP
    //
    // [NOTE] 本 handler **立即 resolve**（不让插件的 host.call 等到流结束），
    //   实际的数据推送通过 host.stream.* 系列消息异步进行。
    'proxy.stream.start': async (ctx, args) => {
      const allow = Array.isArray(ctx.proxyAllow) ? ctx.proxyAllow : [];
      if (allow.length === 0) {
        throw new Error('该插件未配置 proxy 白名单（请在 server/plugin-whitelist.yaml 添加）');
      }
      if (!ctx.iframe || !ctx.iframe.contentWindow) {
        throw new Error('宿主 iframe 不可用');
      }

      const streamId = mustString(args?.streamId, 'streamId', { max: 64 });
      const url = mustString(args?.url, 'url', { max: 2000 });
      const { method, body } = pickMethodAndBody(args);
      const safeHeaders = pickSafeHeaders(args?.headers);

      // origin 预校验
      assertProxyOrigin(url, allow);

      // 通知 iframe 的辅助函数
      const post = (payload) => {
        try {
          ctx.iframe.contentWindow?.postMessage(payload, '*');
        } catch { /* iframe 可能已销毁 */ }
      };

      // 异步发起流，把 host.call 立刻 resolve（插件侧不用等流结束）
      (async () => {
        let reader = null;
        try {
          const res = await fetchPluginProxyStream(ctx.pluginId, {
            url, method, headers: safeHeaders, body
          });
          reader = res.stream.getReader();
          ctx.activeStreams.set(streamId, { reader, cancelled: false });

          // 逐块读到 iframe
          for (;;) {
            if (ctx.activeStreams.get(streamId)?.cancelled) break;
            const { value, done } = await reader.read();
            if (done) break;
            // value 是 Uint8Array；decode 成 UTF-8 字符串
            // stream:true 保证多字节字符（中文、emoji）在跨块时不会被切坏
            const text = new TextDecoder('utf-8').decode(value, { stream: true });
            post({ type: 'host.stream.chunk', streamId, chunk: text });
          }

          if (!ctx.activeStreams.get(streamId)?.cancelled) {
            post({ type: 'host.stream.end', streamId });
          }
        } catch (err) {
          if (!ctx.activeStreams.get(streamId)?.cancelled) {
            post({ type: 'host.stream.error', streamId, error: err?.message || '流式请求失败' });
          }
        } finally {
          try { reader?.cancel(); } catch { /* ignore */ }
          ctx.activeStreams.delete(streamId);
        }
      })();

      // 立即返回，让插件的 host.call 完成
      return { ok: true, streamId };
    },

    'proxy.stream.abort': async (ctx, args) => {
      const streamId = mustString(args?.streamId, 'streamId', { max: 64 });
      const entry = ctx.activeStreams.get(streamId);
      if (!entry) return { ok: true, alreadyStopped: true };
      entry.cancelled = true;
      try { entry.reader.cancel(); } catch { /* ignore */ }
      ctx.activeStreams.delete(streamId);
      return { ok: true };
    },

    // ---------- [NEW] 页面导航 ----------
    //
    // 由插件的 hostAPI.navigate({ type, path, params }) 调用。
    // 宿主收到后更新 pageStack（React 状态），iframe 会因 key 变化而重建，
    // 从而加载新页面。
    //
    // 三种类型：
    //   'to'        —— 打开新页面（进栈）
    //   'back'      —— 返回上一页（出栈）；栈只剩 1 时等价于关闭插件
    //   'redirect'  —— 关闭当前页并打开新页（替换栈顶）
    //
    // [SEC] path 必须出现在 manifest.pages 里 —— 否则拒绝。
    //   这防止插件跳到任意 HTML 文件（虽然都还在插件目录内，但明确列出
    //   才有意义：让作者声明"对外可见的页面集合"）。
    'navigate': async (ctx, args) => {
      const type = String(args?.type || 'to');
      if (!['to', 'back', 'redirect'].includes(type)) {
        throw new Error(`未知的导航类型：${type}`);
      }
      if (typeof ctx.getPageStack !== 'function' || typeof ctx.setPageStack !== 'function') {
        throw new Error('宿主未提供页面栈接口');
      }

      const stack = ctx.getPageStack();

      if (type === 'back') {
        if (stack.length <= 1) {
          // 首页再返回 = 关闭插件
          if (typeof ctx.onClose === 'function') ctx.onClose();
          return { ok: true, closed: true };
        }
        const next = stack.slice(0, -1);
        ctx.setPageStack(next);
        return { ok: true, pageStack: next };
      }

      const path = mustString(args?.path, 'path', { max: 200 });
      const params = (args?.params && typeof args.params === 'object' && !Array.isArray(args.params))
        ? args.params
        : {};

      // 校验 path 在 manifest.pages 里
      const plugin = ctx.plugin;
      if (plugin && Array.isArray(plugin.pages)) {
        const exists = plugin.pages.some((p) => p.path === path);
        if (!exists) {
          throw new Error(`页面不存在：${path}（不在 manifest.pages 里）`);
        }
      }

      if (type === 'redirect') {
        const next = [...stack.slice(0, -1), { path, params }];
        ctx.setPageStack(next);
        return { ok: true, pageStack: next };
      }

      // 'to'
      const next = [...stack, { path, params }];
      ctx.setPageStack(next);
      return { ok: true, pageStack: next };
    },

    'getCurrentPages': async (ctx) => {
      const stack = typeof ctx.getPageStack === 'function' ? ctx.getPageStack() : [];
      return {
        pages: stack.map((p) => ({ path: p.path, params: p.params || {} }))
      };
    }
  };
}

// ============================================================
// 主入口
// ============================================================
/**
 * @param {object} p
 * @param {HTMLIFrameElement} p.iframe
 * @param {string} p.pluginId
 * @param {string[]} p.grantedPerms  用户实际批准过的权限
 * @param {string[]} [p.proxyAllow]  该插件的 proxy 白名单（从 plugin-whitelist.yaml 读）
 * @param {boolean} [p.isOwner]      调用者是否为插件作者（作者豁免权限）
 * @param {object} p.user
 * @param {object[]} [p.friends]
 * @param {object[]} [p.rooms]
 * @param {(text:string)=>void} [p.onToast]
 * @param {()=>void} [p.onClose]
 * @param {(info:object)=>Promise<boolean>} [p.onPayment]  返回是否同意支付
 * @param {(payload:object)=>void} [p.onSendMessage]
 * @param {object} [p.plugin]        插件 DTO（含 pages 列表）
 * @param {()=>Array} [p.getPageStack]  读页面栈
 * @param {(next:Array)=>void} [p.setPageStack]  写页面栈
 * @returns {{dispose:()=>void}}
 *
 * [CHANGED] 参数里删掉了 token —— 桥内部调 API 由 http.js 从
 *   auth/session.js 内存里读 Access Token。
 */
export function createPluginBridge({
  iframe,
  pluginId,
  grantedPerms = [],
  proxyAllow = [],
  isOwner = false,
  user,
  friends = [],
  rooms = [],
  onToast,
  onClose,
  onPayment,
  onSendMessage,
  // [NEW] 多页面路由
  plugin = null,
  getPageStack = null,
  setPageStack = null
}) {
  if (!iframe || !iframe.contentWindow) {
    return { dispose: () => {} };
  }

  const permSet = new Set(Array.isArray(grantedPerms) ? grantedPerms : []);
  const handlers = buildHandlers();

  // 活跃的流（供 proxy.stream.abort 取消）
  const activeStreams = new Map(); // streamId -> { reader, cancelled }

  /** 上下文（每次 host.call 都新建一个，防止插件改它） */
  const makeCtx = () => ({
    pluginId,
    isOwner,
    grantedPerms: permSet,
    proxyAllow: Array.isArray(proxyAllow) ? proxyAllow : [],
    user,
    friends,
    rooms,
    iframe,
    activeStreams,
    onToast,
    onClose,
    onPayment,
    onSendMessage,
    // [NEW] 多页面路由
    plugin,
    getPageStack,
    setPageStack
  });

  const onMessage = async (e) => {
    // [SEC] 必须校验来源 —— 只接受来自当前 iframe 的消息
    if (e.source !== iframe.contentWindow) return;

    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'host.call') return;

    const requestId = data.requestId;
    if (typeof requestId !== 'string' || !requestId) return;

    const method = data.method;
    const args = data.args || {};

    // 回复包装
    const reply = (payload) => {
      try {
        iframe.contentWindow?.postMessage(
          { type: 'host.reply', requestId, ...payload },
          '*'
        );
      } catch {
        /* iframe 可能已销毁 */
      }
    };

    // 未知方法
    const handler = handlers[method];
    if (typeof handler !== 'function') {
      reply({ error: `未知方法：${method}` });
      return;
    }

    try {
      const result = await handler(makeCtx(), args);
      reply({ result });
    } catch (err) {
      // 插件侧的错误不能在宿主里炸开
      reply({ error: err?.message || '宿主处理失败' });
    }
  };

  window.addEventListener('message', onMessage);

  return {
    dispose() {
      window.removeEventListener('message', onMessage);
      // 清理所有活跃流
      for (const [id, entry] of activeStreams) {
        entry.cancelled = true;
        try { entry.reader.cancel(); } catch { /* ignore */ }
        activeStreams.delete(id);
      }
    }
  };
}