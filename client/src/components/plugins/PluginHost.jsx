// client/src/components/plugins/PluginHost.jsx
//
// 插件宿主：iframe 沙箱 + 桥接入 + 票据流程 + **多页面栈**。
//
// [SEC] 两个关键点：
//   1. iframe sandbox 只给 allow-scripts，**不给** allow-same-origin。
//      给了 allow-same-origin，iframe 能自己把 sandbox 属性移除，等于没隔离。
//   2. 桥脚本由**服务端**在返回 entry HTML 时注入（沙箱不给 same-origin，
//      宿主拿不到 contentDocument，无法从宿主侧注入）。
//
// 【本次改动 · 多页面路由】
//   · pageStack 状态：数组，每项 { path, params }（title 由服务端从
//     manifest.pages[].title 覆盖，不需要前端管）
//   · iframe 的 src 由 pageStack 顶部决定：
//       pluginPageUrl(pluginId, ticket, path, params)
//   · iframe 用 key = path + params 的 JSON —— 保证换页时**重建** iframe
//   · 桥的 navigate handler 直接更新 pageStack，触发 iframe 重建
//   · 顶部"返回"按钮：pageStack.length > 1 时显示；点击 = 出栈
//
// 【前几轮修复】
//   · 卸载清票据改为"延迟撤销"（躲 StrictMode 的"挂载→卸载→挂载"）
//   · 认证改造：不再接收 token prop
//   · 白名单：从后端 DTO 的 plugin.proxy 读
//
import { useEffect, useRef, useState } from 'react';
import {
  getPlugin,
  requestPluginTicket,
  pluginPageUrl
} from '../../api';
import { createPluginBridge } from '../../utils/pluginBridge';
import * as session from '../../auth/session';
import { API_BASE } from '../../api/http';

export default function PluginHost({
  pluginId,
  user,
  friends,
  rooms,
  onClose,
  onToast,
  onPayment,
  onSendMessage
}) {
  const [phase, setPhase] = useState('loading'); // loading | ready | error
  const [plugin, setPlugin] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');

  // [NEW] 页面栈：{ path, params }
  const [pageStack, setPageStack] = useState([]);

  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  // [FIX C4] 延迟撤销票据用的定时器句柄
  const revokeTimerRef = useRef(null);
  // 让 navigate handler 读到最新的 pageStack
  const pageStackRef = useRef([]);

  useEffect(() => { pageStackRef.current = pageStack; }, [pageStack]);

  // 加载 plugin 详情 + 申请票据 + 初始化页面栈
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    setError('');
    (async () => {
      try {
        const d = await getPlugin(pluginId);
        if (!alive) return;
        const pl = d?.plugin;
        if (!pl) throw new Error('插件不存在');
        if (!pl.installed && !pl.isOwner) throw new Error('未安装该插件');
        setPlugin(pl);

        // 初始化页面栈：[第一页]
        const pages = (Array.isArray(pl.pages) && pl.pages.length > 0)
          ? pl.pages
          : [{ path: pl.entry }];
        setPageStack([{ path: pages[0].path, params: {} }]);

        const t = await requestPluginTicket(pluginId);
        if (!alive) return;
        setTicket(t.ticket);
        setPhase('ready');
      } catch (err) {
        if (alive) {
          setError(err.message || '加载失败');
          setPhase('error');
        }
      }
    })();
    return () => { alive = false; };
  }, [pluginId]);

  // 桥：依赖 pageStack（换页时重建，因为 iframe 是新对象）
  useEffect(() => {
    if (phase !== 'ready' || !plugin || !ticket) return undefined;
    const iframe = iframeRef.current;
    if (!iframe) return undefined;

    const b = createPluginBridge({
      iframe,
      pluginId,
      grantedPerms: plugin.grantedPerms || [],
      proxyAllow: Array.isArray(plugin.proxy) ? plugin.proxy : [],
      isOwner: !!plugin.isOwner,
      user,
      friends: friends || [],
      rooms: rooms || [],
      onToast: onToast || (() => {}),
      onClose: onClose || (() => {}),
      onPayment: onPayment || (async () => false),
      onSendMessage: onSendMessage || (() => {}),
      // [NEW] 页面栈
      plugin,
      getPageStack: () => pageStackRef.current,
      setPageStack
    });
    bridgeRef.current = b;

    return () => {
      b.dispose();
      bridgeRef.current = null;
    };
  }, [phase, plugin, ticket, pageStack, pluginId, user, friends, rooms, onClose, onToast, onPayment, onSendMessage]);

  // 卸载时通知服务端作废本用户在该插件下的所有票据（延迟撤销躲 StrictMode）
  useEffect(() => {
    if (revokeTimerRef.current) {
      clearTimeout(revokeTimerRef.current);
      revokeTimerRef.current = null;
    }
    return () => {
      if (!pluginId) return;
      revokeTimerRef.current = setTimeout(() => {
        revokeTimerRef.current = null;
        const access = session.getAccessToken();
        if (!access) return;
        fetch(`${API_BASE}/plugins/${encodeURIComponent(pluginId)}/ticket`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${access}` },
          credentials: 'include'
        }).catch(() => {});
      }, 300);
    };
  }, [pluginId]);

  const handleReload = () => {
    setPhase('loading');
    setError('');
    (async () => {
      try {
        const t = await requestPluginTicket(pluginId);
        setTicket(t.ticket);
        setPhase('ready');
      } catch (err) {
        setError(err.message || '加载失败');
        setPhase('error');
      }
    })();
  };

  // 返回上一页（栈只剩 1 时无操作，用顶部"返回"按钮直接关插件）
  const handleBack = () => {
    setPageStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const currentPage = pageStack[pageStack.length - 1];
  const iframeSrc = (ticket && currentPage)
    ? pluginPageUrl(pluginId, ticket, currentPage.path, currentPage.params)
    : 'about:blank';

  // iframe key：保证换页时重建（React 会 unmount 旧 iframe + mount 新 iframe）
  const iframeKey = currentPage
    ? `${currentPage.path}|${JSON.stringify(currentPage.params || {})}`
    : 'blank';

  return (
    <div className="plg-host">
      <div className="plg-host-head">
        <span className="plg-host-icon">
          {plugin?.iconUrl
            ? <img src={plugin.iconUrl} alt="" />
            : (plugin?.name || pluginId || '?').slice(0, 1)}
        </span>
        <div>
          <div className="plg-host-name">{plugin?.name || pluginId}</div>
          <div className="plg-host-ver">
            v{plugin?.version || '-'}
            {plugin?.isOwner ? ' · 你自己的插件' : ''}
            {pageStack.length > 1 ? ` · 栈深 ${pageStack.length}` : ''}
          </div>
        </div>
        <div className="plg-host-actions">
          {/* [NEW] 返回上一页 —— 栈深 > 1 时显示 */}
          {pageStack.length > 1 && (
            <button className="action-btn" onClick={handleBack} title="返回上一页">
              返回上一页
            </button>
          )}
          <button className="action-btn" onClick={handleReload} title="重新申请票据并刷新">
            重新加载
          </button>
          <button className="action-btn" onClick={onClose}>返回</button>
        </div>
      </div>

      <div className="plg-host-frame-wrap">
        {phase === 'loading' && <div className="plg-loading">加载中…</div>}
        {phase === 'error' && (
          <div className="plg-error">
            <div>无法打开插件</div>
            <div style={{ fontSize: 12, color: '#999' }}>{error}</div>
            <button className="btn-secondary" onClick={onClose} style={{ marginTop: 8 }}>
              返回
            </button>
          </div>
        )}
        {phase === 'ready' && (
          <iframe
            // [NEW] key 由页面栈顶部决定：换页 → key 变 → iframe 重建 → 桥重建
            key={iframeKey}
            ref={iframeRef}
            className="plg-frame"
            // [SEC] 只给 allow-scripts —— 这是整个沙箱方案的核心。
            //   加了 allow-same-origin：iframe 就能自己把 sandbox 属性移掉，
            //   拿到宿主的 DOM / cookie / localStorage，等于没隔离。
            sandbox="allow-scripts"
            src={iframeSrc}
            title={plugin?.name || pluginId}
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}