import { useEffect, useState } from 'react';
import { adminAuditLogs } from '../../api';
import { formatShortDateTime } from '../../utils/timeUtils';

/**
 * 管理面板 · 审计日志。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function AdminAuditTab() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    adminAuditLogs(200)
      .then((d) => {
        if (alive) setLogs(d.logs || []);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="admin-tab-content">
      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="modal-empty">加载中...</div>}
      {!loading && logs.length === 0 && (
        <div className="modal-empty">暂无日志</div>
      )}

      <div className="audit-list">
        {logs.map((l) => (
          <div key={l.id} className="audit-row">
            <div className="audit-main">
              <div className="audit-title">
                <strong>{l.actorName || `#${l.actorId}`}</strong>
                <span className="audit-action">{actionLabel(l.action)}</span>
                <span className="audit-target">
                  {l.targetType === 'user' ? '用户' : '商品'} #{l.targetId}
                </span>
              </div>
              {l.detail && <div className="audit-detail">{l.detail}</div>}
            </div>
            <div className="audit-time">
              {formatShortDateTime(l.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function actionLabel(a) {
  return (
    {
      disable: '禁用',
      ban: '查封',
      unban: '解除',
      delist: '下架',
      hide: '隐藏',
      unhide: '取消隐藏',
      grant_admin: '授予管理员',
      revoke_admin: '撤销管理员',
      grant_moderator: '授予审核员',
      approve_promotion: '批准升职',
      reject_promotion: '拒绝升职',
      review_price: '定价审核',
      official_publish: '官方上架'
    }[a] || a
  );
}