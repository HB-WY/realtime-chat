// client/src/components/plugins/PluginDetailDialog.jsx
//
// 插件详情（"右键 → 详情" 打开）。
// 只读展示，不涉及任何写操作 —— 写操作都在 PluginManager 的右键菜单里。
//
// 设计取舍：
//   · 权限说明用本地映射表（`PERM_LABEL`），不从后端下发
//     → 后端被攻破也改不了展示给用户的文案
//   · 权限项同时展示「中文说明」+「原始 key」：说明给人看，key 便于排查
//   · 分享码用 user-select: all，方便一键全选复制
//
// [NEW] proxy 白名单展示：
//   · 只有 developer 上传的插件才有（服务端强制）
//   · 让用户能看到"这个插件能访问哪些外部域名"
//   · 具体请求还要走 /plugins/:id/proxy，服务端会再校验 origin
//
import { useEffect } from 'react';

// 权限的中文说明。后端新增权限但这里没列时会 fallback 到 key 本身。
const PERM_LABEL = {
  'user:read':       '读取你的昵称和头像',
  'user:friends':    '读取你的好友列表',
  'room:list':       '读取你的会话列表',
  'message:send':    '以你的身份发消息',
  'storage':         '保存它自己的数据',
  'ui:toast':        '弹出通知提示',
  'ui:close':        '关闭自己',
  'payment:request': '发起积分支付请求'
};

const STATUS_LABEL = {
  active:   '正常',
  hidden:   '已隐藏',
  delisted: '已下架'
};

export default function PluginDetailDialog({
  plugin,
  isAdmin,
  onClose,
  onLaunch
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!plugin) return null;

  const perms = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  // [NEW] proxy 白名单：只有 developer 上传的插件才会非空
  const proxy = Array.isArray(plugin.proxy) ? plugin.proxy : [];

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card plg-detail-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">小程序详情</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {/* ---------- 头部：图标 + 名称 + 版本 + 状态 ---------- */}
        <div className="plg-detail-head">
          <span className="plg-detail-icon">
            {plugin.iconUrl
              ? <img src={plugin.iconUrl} alt="" />
              : <span>{(plugin.name || '?').slice(0, 1)}</span>}
          </span>
          <div className="plg-detail-main">
            <div className="plg-detail-name">{plugin.name}</div>
            <div className="plg-detail-sub">
              v{plugin.version} · <code>{plugin.id}</code>
            </div>
            <div className="plg-detail-tags">
              {plugin.isOwner && <span className="plg-tag own">我的</span>}
              {plugin.installed && !plugin.isOwner && <span className="plg-tag installed">已安装</span>}
              {plugin.isPublic && <span className="plg-tag public">公开</span>}
              {plugin.status !== 'active' && (
                <span className={`plg-tag ${plugin.status}`}>
                  {STATUS_LABEL[plugin.status]}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ---------- 描述 ---------- */}
        <div className="plg-detail-desc">
          {plugin.description || '（无描述）'}
        </div>

        {/* ---------- 权限 ---------- */}
        <div className="plg-detail-section">
          <div className="plg-detail-section-title">权限</div>
          {perms.length === 0 ? (
            <div className="plg-detail-empty">该小程序不需要任何权限</div>
          ) : (
            <ul className="plg-detail-perms">
              {perms.map((k) => (
                <li key={k}>
                  <span className="plg-detail-perm-label">{PERM_LABEL[k] || k}</span>
                  <span className="plg-detail-perm-key">{k}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------- [NEW] 代理白名单 ---------- */}
        {proxy.length > 0 && (
          <div className="plg-detail-section">
            <div className="plg-detail-section-title">可访问的外部域名</div>
            <ul className="plg-detail-perms">
              {proxy.map((origin) => (
                <li key={origin}>
                  <span className="plg-detail-perm-label">{origin}</span>
                  <span className="plg-detail-perm-key">proxy</span>
                </li>
              ))}
            </ul>
            <div className="plg-detail-empty" style={{ marginTop: 4 }}>
              该小程序可通过服务端代理抓取以上域名的 HTTPS 资源（不读取你的 cookie）。
            </div>
          </div>
        )}

        {/* ---------- 分享码（仅作者可见） ---------- */}
        {plugin.isOwner && plugin.shareCode && (
          <div className="plg-detail-section">
            <div className="plg-detail-section-title">分享码</div>
            <div className="plg-detail-share">{plugin.shareCode}</div>
          </div>
        )}

        {/* ---------- 操作 ---------- */}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>关闭</button>
          {plugin.status === 'active' && (
            <button className="auth-submit" onClick={onLaunch}>
              {plugin.installed ? '打开' : '下载并打开'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}