import { useEffect, useState } from 'react';
import { listIpClaims, releaseIpClaim } from '../../api';
import { formatDateTime } from '../../utils/timeUtils';

/**
 * 管理面板 · API 密钥 IP 绑定。
 *
 * 同一 IP 只能绑定一个账号，且撤销密钥不会释放绑定，
 * 所以这里是管理员唯一的「解绑」入口。
 * 直接渲染在 admin-tab-body 里，不要再套弹窗。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function AdminApiKeysTab({ me, can }) {
  const hasPerm = typeof can === 'function' ? can('manage_apikeys') : true;

  const [claims, setClaims] = useState([]);
  const [all, setAll] = useState(false); // 是否包含已释放的绑定
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (includeAll = all) => {
    setLoading(true);
    setError('');
    try {
      const d = await listIpClaims(includeAll);
      setClaims(d.claims || []);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!hasPerm) {
      setLoading(false);
      return;
    }
    load(all);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hasPerm]);

  const release = async (c) => {
    // 释放记录会挂到当前管理员名下，提示里带上操作者便于确认
    const operator = me?.nickname || me?.username || '当前管理员';
    const ok = confirm(
      `确定释放 IP ${c.ip} 的绑定？释放后其他账号可以从这个 IP 申请密钥并绑定，` +
        `原账号已签发的密钥本身不受影响。\n本次操作将记录为：${operator}`
    );
    if (!ok) return;
    const note = prompt('释放备注（可选）：');
    if (note === null) return; // 取消
    try {
      await releaseIpClaim({ ip: c.ip, note: note.trim() });
      alert('已释放该 IP 绑定');
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  if (!hasPerm) {
    return <div className="modal-empty">需要「管理 API 密钥」权限</div>;
  }

  const q = keyword.trim().toLowerCase();
  const rows = claims.filter((c) => {
    if (!q) return true;
    return (
      String(c.ip || '').toLowerCase().includes(q) ||
      String(c.username || '').toLowerCase().includes(q) ||
      String(c.nickname || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="admin-tab-content ak-claims">
      <div className="ak-toolbar">
        <input
          className="auth-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按 IP 或用户名筛选"
        />
        <label className="ak-check">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          包含已释放
        </label>
      </div>

      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}
      {!loading && rows.length === 0 && (
        <div className="modal-empty">暂无 IP 绑定记录</div>
      )}

      <div className="admin-list">
        {rows.map((c) => {
          const released = !!c.releasedAt;
          return (
            <div
              key={`${c.ip}-${c.userId}-${c.updatedAt || c.createdAt || ''}`}
              className="admin-user-row ak-claim"
            >
              <div className="admin-user-info">
                <div className="admin-user-name">
                  <span className="ak-mono">{c.ip}</span>
                  <span className={`ak-tag ${released ? 'revoked' : 'active'}`}>
                    {released
                      ? `已于 ${formatDateTime(c.releasedAt)} 释放`
                      : '生效中'}
                  </span>
                </div>
                <div className="admin-user-sub">
                  绑定用户：{c.nickname || '未知'}（@{c.username || '—'}）
                </div>
                <div className="admin-user-sub">
                  绑定时间 {formatDateTime(c.createdAt)} · 更新时间{' '}
                  {formatDateTime(c.updatedAt || c.createdAt)} · 密钥数{' '}
                  {c.keyCount ?? 0}
                </div>
                <div className="admin-user-sub">
                  备注：{c.note || '—'}
                  {released && c.releasedBy ? ` · 释放人 ${c.releasedBy}` : ''}
                </div>
              </div>
              <div className="admin-user-actions">
                {!released && (
                  <button
                    className="btn-danger-mini"
                    onClick={() => release(c)}
                  >
                    释放绑定
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}