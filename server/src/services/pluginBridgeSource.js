// src/services/pluginBridgeSource.js
//
// 构建 iframe 加载的 entry HTML + 页面 HTML（**服务端权威版本**）。
//
// 为什么服务端要负责：
//   1) iframe sandbox 不给 allow-same-origin → 宿主**拿不到** contentDocument，
//      无法从宿主侧注入 <script>。桥脚本必须由服务端在返回 HTML 时内联进 <head>。
//   2) 资源路径要带 ticket。用户在插件项目里写 `<link href="style.css">`
//      是自然写法，但浏览器会把相对路径解析成 /api/plugins/:id/style.css
//      —— 没有 ticket → 401。所以我们注入 <base> 标签，让所有相对 URL
//      自动带上 /a/:ticket/ 前缀（见 routes/plugins.js 的 /a/:ticket/* 路由）。
//
// [SEC] 桥脚本严格只做 postMessage 收发 + 请求响应配对 + 超时。
//   它不暴露任何宿主信息，也不做任何鉴权；所有权限判断都在宿主侧。
//
// [CHANGED] v1 → v2：
//   · hostAPI.stream(url, opts) 新增 —— 真流式接口，返回 AsyncIterable
//
// [CHANGED] v2 → v3（多页面路由）：
//   · hostAPI.navigate({ type, path, params }) —— 页面跳转
//       type: 'to'      打开新页面（进栈）
//             'back'    返回上一页（出栈）
//             'redirect' 关闭当前页并打开新页（替换栈顶）
//   · hostAPI.getCurrentPages() —— 获取页面栈
//   · hostAPI.getLaunchParams() —— 获取当前页面的入参（从 URL 解析）
//   · hostAPI.onPageShow(cb) / onPageHide(cb) —— 页面生命周期订阅（宿主推）
//   · version 从 2 → 3
//
// [NOTE] <base> 指向**资源根** `/api/plugins/:id/a/:ticket/`，因此插件项目里
//   引用资源要用**从资源根算的路径**：
//     pages/index/index.html 引用同目录的 CSS → href="pages/index/index.css"
//   这不如"从当前文件算相对路径"简洁，但能保证 <base> 是单层的、路径无法逃逸。
//
const TIMEOUT_MS = 30000;

const HOST_API_SOURCE = `
(function(){
  if (window.hostAPI) return;
  var seq = 0;
  var pending = Object.create(null);
  var streams = Object.create(null);      // streamId -> { onChunk, onEnd, onError }
  var pageListeners = { show: [], hide: [] };
  var TIMEOUT = ${TIMEOUT_MS};

  function onMessage(e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;

    // ---- 请求-响应配对 ----
    if (d.type === 'host.reply') {
      var p = pending[d.requestId];
      if (!p) return;
      delete pending[d.requestId];
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
      return;
    }

    // ---- 流式消息 ----
    if (d.type === 'host.stream.chunk'
        || d.type === 'host.stream.end'
        || d.type === 'host.stream.error') {
      var s = streams[d.streamId];
      if (!s) return;
      if (d.type === 'host.stream.chunk') {
        if (s.onChunk) s.onChunk(d.chunk);
      } else if (d.type === 'host.stream.end') {
        if (s.onEnd) s.onEnd();
      } else {
        if (s.onError) s.onError(d.error);
      }
      return;
    }

    // ---- 页面生命周期（宿主主动推） ----
    if (d.type === 'host.page.show' || d.type === 'host.page.hide') {
      var kind = d.type === 'host.page.show' ? 'show' : 'hide';
      var list = pageListeners[kind];
      for (var i = 0; i < list.length; i++) {
        try { list[i](d.params || {}); } catch (err) { /* 用户回调抛错不能影响桥 */ }
      }
    }
  }

  function call(method, args) {
    return new Promise(function(resolve, reject){
      var requestId = 'r' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
      var timer = setTimeout(function(){
        if (pending[requestId]) {
          delete pending[requestId];
          reject(new Error('宿主响应超时（' + method + '）'));
        }
      }, TIMEOUT);
      pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
      try {
        window.parent.postMessage(
          { type: 'host.call', method: method, args: args || {}, requestId: requestId },
          '*'
        );
      } catch (err) {
        clearTimeout(timer);
        delete pending[requestId];
        reject(err);
      }
    });
  }

  // ---- 流式 ----
  function stream(url, opts) {
    var streamId = 's' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
    var chunks = [];
    var resolvers = [];
    var done = false;
    var error = null;

    streams[streamId] = {
      onChunk: function (c) {
        if (resolvers.length) resolvers.shift().resolve({ value: c, done: false });
        else chunks.push(c);
      },
      onEnd: function () {
        done = true;
        while (resolvers.length) resolvers.shift().resolve({ value: undefined, done: true });
        delete streams[streamId];
      },
      onError: function (msg) {
        error = new Error(msg || '流式请求失败');
        while (resolvers.length) resolvers.shift().reject(error);
        delete streams[streamId];
      }
    };

    call('proxy.stream.start', {
      streamId: streamId,
      url: url,
      method: opts && opts.method,
      headers: opts && opts.headers,
      body: opts && opts.body
    }).catch(function (err) {
      if (streams[streamId] && streams[streamId].onError) {
        streams[streamId].onError(err.message);
      }
    });

    var iterator = {
      next: function () {
        if (error) return Promise.reject(error);
        if (chunks.length) return Promise.resolve({ value: chunks.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve, reject) {
          resolvers.push({ resolve: resolve, reject: reject });
        });
      },
      return: function () {
        call('proxy.stream.abort', { streamId: streamId }).catch(function () {});
        done = true;
        delete streams[streamId];
        return Promise.resolve({ value: undefined, done: true });
      }
    };

    var obj = {};
    obj[Symbol.asyncIterator] = function () { return iterator; };
    return obj;
  }

  // ---- 页面导航 ----
  /**
   * @param {{ type?: 'to'|'back'|'redirect', path?: string, params?: object }} opts
   *   - type 默认 'to'
   *   - path 目标页面路径（必须出现在 manifest.pages 里）
   *   - params 传给目标页面的参数（会序列化进 URL 的 __params 查询串）
   * @returns {Promise<{ ok:boolean, closed?:boolean, pageStack?:Array }>}
   */
  function navigate(opts) {
    var o = opts || {};
    return call('navigate', {
      type: o.type || 'to',
      path: o.path,
      params: o.params || {}
    });
  }

  function getCurrentPages() {
    return call('getCurrentPages', {}).then(function (res) {
      return (res && res.pages) || [];
    });
  }

  /**
   * 当前页面的入参。
   * 页面的 URL 由宿主生成为：
   *   /api/plugins/:id/p/:ticket/<pagePath>?__params=<json-encoded>
   * 所以直接从 location.search 里解析即可，不需要走宿主。
   */
  function getLaunchParams() {
    try {
      var search = window.location.search;
      if (!search) return {};
      var m = search.match(/[?&]__params=([^&]+)/);
      if (!m) return {};
      var json = decodeURIComponent(m[1]);
      var obj = JSON.parse(json);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function onPageShow(cb) { if (typeof cb === 'function') pageListeners.show.push(cb); }
  function onPageHide(cb) { if (typeof cb === 'function') pageListeners.hide.push(cb); }

  window.addEventListener('message', onMessage);

  window.hostAPI = {
    call: call,
    stream: stream,
    navigate: navigate,
    getCurrentPages: getCurrentPages,
    getLaunchParams: getLaunchParams,
    onPageShow: onPageShow,
    onPageHide: onPageHide,
    version: 3
  };
})();
`;

/** HTML 转义（只用于 <title> 里的 pageTitle） */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 构建 iframe 加载的页面 HTML。
 *
 * 注入三样东西（顺序很重要）：
 *   1) <base href="/api/plugins/:id/a/:ticket/"> —— 让**所有相对 URL** 自动带 ticket
 *      指向**资源通道**（不是页面通道）。插件项目里引用 CSS/JS/图片
 *      都要基于**资源根**：例如 `pages/index/index.css`
 *   2) <title>（可选）—— 从 manifest.pages[].title 覆盖 HTML 原有 title
 *   3) 桥脚本 —— 提供 window.hostAPI
 *
 * [SEC] <base> 必须在**第一个相对 URL** 之前（HTML 规范要求），所以我们
 *   一律注到 <head> 的最开头。
 *
 * @param {string} rawHtml  磁盘上的原始 HTML
 * @param {{ pluginId:string, ticket:string, pageTitle?:string }} opts
 * @returns {string}  注入后的 HTML
 */
function buildEntryHtml(rawHtml, { pluginId, ticket, pageTitle = '' }) {
  const baseHref = `/api/plugins/${pluginId}/a/${ticket}/`;
  const baseSnippet = `<base href="${baseHref}">`;
  const titleSnippet = pageTitle ? `<title>${escapeHtml(pageTitle)}</title>` : '';
  const bridgeSnippet = `<script data-injected="host-api">${HOST_API_SOURCE}</script>`;
  const injected = baseSnippet + titleSnippet + bridgeSnippet;

  // 优先注入到 <head> 开头
  if (/<head[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${injected}`);
  }
  // 没有 <head> 就注入到 <html> 后（补一个 head）
  if (/<html[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<html([^>]*)>/i, (m, attrs) => `<html${attrs}><head>${injected}</head>`);
  }
  // 什么标签都没有 → 包一层
  return `<!doctype html><html><head><meta charset="utf-8">${injected}</head><body>${rawHtml}</body></html>`;
}

// [DEPRECATED] 只做桥脚本注入的旧接口。新代码请用 buildEntryHtml
// （它同时处理 base + title + 桥）。
function injectBridge(html) {
  const snippet = `<script data-injected="host-api">${HOST_API_SOURCE}</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${snippet}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (m, attrs) => `<html${attrs}>${snippet}`);
  }
  return snippet + html;
}

module.exports = { HOST_API_SOURCE, buildEntryHtml, injectBridge };