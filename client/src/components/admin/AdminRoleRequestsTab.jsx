// client/src/components/admin/AdminRoleRequestsTab.jsx
//
// [FIX C3] review() 里的 `prompt(...) ?? null` 去掉了多余的 `?? null`：
//   prompt 本来就在「取消」时返回 null、其他情况返回字符串，`??` 不改变结果。
//   取消 → note === null → 直接 return（放弃操作）；
//   空字符串 → 走下面的 reviewRoleRequest（视为"无备注"）。
//
// [CHANGED] 认证改造：不再接收 token prop。
// [FIX] 删掉无用的 eslint-disable 注释 —— 改造后 load() 不再依赖外部变量。
//
import { useEffect, useState } from 'react';
import Avatar from '../common/Avatar';
import { getPendingRoleRequests, reviewRoleRequest } from '../../api';
import { formatShortDateTime } from '../../utils/timeUtils';

export default function AdminRoleRequestsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getPendingRoleRequests();
      setItems(d.requests || []);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const review = async (r, approve) => {
    const note = prompt(approve ? '通过备注（可选）：' : '拒绝理由：');
    if (note === null) return;
    try {
      await reviewRoleRequest(r.id, approve, note);
      alert(approve ? '已通过' : '已拒绝');
      load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  return (
    <div className="admin-tab-content">
      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="modal-empty">暂无待审批申请</div>
      )}

      <div className="admin-list">
        {items.map((r) => (
          <div key={r.id} className="review-row">
            <Avatar name={r.nickname} avatar={r.avatar} size={32} />
            <div className="review-info">
              <div className="review-title">
                {r.nickname}（@{r.username}）
              </div>
              <div className="review-meta">
                申请：{roleLabel(r.fromRole)} →{' '}
                <strong>{roleLabel(r.toRole)}</strong>
              </div>
              {r.reason && <div className="review-desc">{r.reason}</div>}
              <div className="review-meta">
                提交于 {formatShortDateTime(r.createdAt)}
              </div>
            </div>
            <div className="review-actions">
              <button className="mini-btn ok" onClick={() => review(r, true)}>
                通过
              </button>
              <button
                className="mini-btn danger"
                onClick={() => review(r, false)}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}
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
      user: '用户'
    }[r] || r
  );
}