// client/src/components/admin/AdminPluginsTab.jsx
//
// 管理面板 · 插件管理。
//
//   · 状态筛选（全部 / 正常 / 已隐藏 / 已下架）
//   · 关键词搜索（名称 / id）
//   · 列表展示：图标、名称、id、版本、作者、安装数、状态
//   · 操作：隐藏（软下架）/ 下架 / 恢复
//
// 与作者自助管理的区别：
//   · 这里能看到**全部**用户的插件（含 hidden / delisted）
//   · 只能下架 / 隐藏 / 恢复，不能修改内容、不能代替作者删除
//
// [CHANGED] 认证改造：不再接收 token prop。
// [FIX] 删掉两个未使用的 import（Avatar / Icon）—— 本轮改造把用到它们
//   的 UI 片段移除了，import 忘了同步清理，eslint no-unused-vars 会报 error。
//
import { useEffect, useState } from 'react';
import {
  adminListPlugins,
  adminPluginStats,
  adminHidePlugin,
  adminRestorePlugin,
  delistPlugin
} from '../../api';
import { formatShortDateTime } from '../../utils/timeUtils';

const STATUS_TABS = [
  { key: '',         label: '全部' },
  { key: 'active',   label: '正常' },
  { key: 'hidden',   label: '已隐藏' },
  { key: 'delisted', label: '已下架' }
];

const STATUS_LABEL = {
  active:   '正常',
  hidden:   '已隐藏',
  delisted: '已下架'
};

export default function AdminPluginsTab() {
  const [tab, setTab] = useState('');
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [listRes, statsRes] = await Promise.all([
        adminListPlugins({ status: tab, keyword: keyword.trim(), limit: 200 }),
        adminPluginStats()
      ]);
      setItems(listRes.plugins || []);
      setStats(statsRes);
    } catch (err) {
      setError(err.message || '加载失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const handleDelist = async (p) => {
    const reason = prompt(`下架「${p.name}」的原因：`);
    if (reason === null) return;
    try {
      await delistPlugin(p.id, reason || '管理员下架');
      alert('已下架');
      load();
    } catch (err) {
      alert(err.message || '下架失败');
    }
  };

  const handleHide = async (p) => {
    const reason = prompt(`隐藏「${p.name}」的原因：`);
    if (reason === null) return;
    try {
      await adminHidePlugin(p.id, reason || '管理员隐藏');
      alert('已隐藏');
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const handleRestore = async (p) => {
    if (!confirm(`恢复「${p.name}」为正常状态？`)) return;
    try {
      await adminRestorePlugin(p.id);
      alert('已恢复');
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  return (
    <div className="admin-tab-content">
      {/* 总览统计 */}
      {stats && (
        <div className="admin-list" style={{ marginBottom: 10 }}>
          <div className="review-row" style={{ background: '#f8f9fa' }}>
            <div className="review-info">
              <div className="review-title">
                插件总览
              </div>
              <div className="review-meta">
                共 {stats.total} 个插件 ·
                正常 {stats.active} ·
                隐藏 {stats.hidden} ·
                下架 {stats.delisted} ·
                公开 {stats.publicCount}
              </div>
              <div className="review-meta">
                安装总数 {stats.installTotal} 次 ·
                付费 {stats.paidCount} 笔 ·
                累计 {stats.paidSum} 积分
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 状态筛选 + 搜索 */}
      <div className="search-row">
        <input
          className="auth-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
          placeholder="按插件名或 id 搜索"
        />
        <button className="auth-submit" style={{ width: 100, marginTop: 0 }} onClick={load}>
          搜索
        </button>
      </div>

      <div className="admin-tabs" style={{ marginTop: 8 }}>
        {STATUS_TABS.map((t) => (
          <button
            key={t.key || 'all'}
            className={`admin-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="modal-empty">暂无插件</div>
      )}

      <div className="admin-list">
        {items.map((p) => (
          <div key={p.id} className="admin-user-row">
            <span className="plg-card-icon">
              {p.iconUrl
                ? <img src={p.iconUrl} alt="" />
                : (p.name || '?').slice(0, 1)}
            </span>
            <div className="admin-user-info">
              <div className="admin-user-name">
                {p.name}
                <span className={`plg-tag ${p.status === 'active' ? 'own' : p.status === 'hidden' ? 'hidden' : 'delisted'}`}>
                  {STATUS_LABEL[p.status] || p.status}
                </span>
                {p.isPublic && <span className="plg-tag public">公开</span>}
              </div>
              <div className="admin-user-sub">
                id <span className="ak-mono">{p.id}</span> · v{p.version}
              </div>
              <div className="admin-user-sub">
                作者 {p.ownerName || `#${p.ownerId}`}
                {p.ownerUsername ? ` (@${p.ownerUsername})` : ''}
                {' · '}安装 {p.installCount ?? 0} 次
                {' · '}更新 {formatShortDateTime(p.updatedAt)}
              </div>
              {p.permissions?.length > 0 && (
                <div className="admin-user-sub">
                  权限：{p.permissions.join(' / ')}
                </div>
              )}
            </div>
            <div className="admin-user-actions">
              {p.status === 'active' && (
                <>
                  <button className="mini-btn" onClick={() => handleHide(p)}>
                    隐藏
                  </button>
                  <button className="mini-btn danger" onClick={() => handleDelist(p)}>
                    下架
                  </button>
                </>
              )}
              {p.status !== 'active' && (
                <button className="mini-btn ok" onClick={() => handleRestore(p)}>
                  恢复
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}