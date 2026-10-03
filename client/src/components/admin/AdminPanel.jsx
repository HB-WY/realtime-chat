import { useState } from 'react';
import adminTabsFor from './adminTabs';

/**
 * 管理面板。按 can() 决定显示哪些 Tab。
 * 不同角色看到的入口不同，但真正的权限检查在后端。
 *
 * [CHANGED] 认证改造：不再接收 / 传递 token prop。
 *   各 Admin*Tab 现在直接调 http.js，由 auth/session.js 内存里读 Access。
 */
export default function AdminPanel({ me, can, onClose, initialTab }) {
  const tabs = adminTabsFor(can);

  const [active, setActive] = useState(
    () => (tabs.some((t) => t.key === initialTab) ? initialTab : tabs[0]?.key) || ''
  );
  const ActiveComp = tabs.find((t) => t.key === active)?.component;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card admin-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">管理面板 · {roleLabel(me.role)}</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {tabs.length === 0 ? (
          <div className="modal-empty">你没有管理权限</div>
        ) : (
          <>
            <div className="admin-tabs">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  className={`admin-tab ${active === t.key ? 'active' : ''}`}
                  onClick={() => setActive(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="admin-tab-body">
              {ActiveComp && <ActiveComp me={me} can={can} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function roleLabel(r) {
  return (
    {
      developer: '开发者',
      super_admin: '超级管理员',
      admin: '管理员',
      user: '普通用户'
    }[r] || r
  );
}