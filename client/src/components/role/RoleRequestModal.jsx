import { useEffect, useState } from 'react';
import { requestRolePromotion, getMyRoleRequests } from '../../api';
import { formatDateTime } from '../../utils/timeUtils';

const TARGETS = [
  { key: 'super_admin', label: '超级管理员', desc: '分发管理员、查封账号' },
  { key: 'developer', label: '开发者', desc: '最高权限，唯一能审核定价' }
];

/**
 * 升职申请（整页）。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 * [FIX] 删掉无用的 eslint-disable 注释 —— 改造后 reload() 不再依赖外部变量。
 */
export default function RoleRequestModal({ me, onClose }) {
  const [target, setTarget] = useState('super_admin');
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState([]);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => {
    setLoading(true);
    try {
      const d = await getMyRoleRequests();
      setHistory(d.requests || []);
      setCooldownMs(d.cooldownRemainingMs || 0);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const inCooldown = cooldownMs > 0;
  const daysLeft = Math.ceil(cooldownMs / (24 * 60 * 60 * 1000));

  const submit = async () => {
    setError('');
    setSubmitting(true);
    try {
      await requestRolePromotion(target, reason.trim());
      alert('申请已提交，等待开发者审批');
      setReason('');
      reload();
    } catch (err) {
      setError(err.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !submitting && onClose()}>
      <div
        className="modal-card"
        style={{ maxWidth: 480 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">升职</span>
          <button className="icon-btn" onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <div className="current-role">
          当前角色：<strong>{roleLabel(me.role)}</strong>
        </div>

        {inCooldown && (
          <div className="cooldown-hint">
            距上次升职不足 7 天，还需等待约 {daysLeft} 天
          </div>
        )}

        <label className="modal-label">升职目标</label>
        <div className="market-picker">
          {TARGETS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`market-choice ${target === t.key ? 'active' : ''}`}
              onClick={() => setTarget(t.key)}
              disabled={submitting || inCooldown}
            >
              <div className="market-choice-name">{t.label}</div>
              <div className="market-choice-tip">{t.desc}</div>
            </button>
          ))}
        </div>

        <label className="modal-label">申请理由</label>
        <textarea
          className="auth-input"
          rows={4}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="简要说明你的贡献和申请理由..."
          disabled={submitting || inCooldown}
          style={{ resize: 'vertical', minHeight: 80 }}
        />

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="auth-submit"
            onClick={submit}
            disabled={submitting || inCooldown || !reason.trim()}
          >
            {submitting ? '提交中...' : '提交申请'}
          </button>
        </div>

        <label className="modal-label" style={{ marginTop: 20 }}>
          我的申请记录
        </label>
        <div className="role-requests-list">
          {loading && <div className="modal-empty">加载中...</div>}
          {!loading && history.length === 0 && (
            <div className="modal-empty">暂无记录</div>
          )}
          {history.map((r) => (
            <div key={r.id} className="role-request-row">
              <div className="role-request-main">
                <div className="role-request-title">
                  {roleLabel(r.fromRole)} → {roleLabel(r.toRole)}
                </div>
                <div className="role-request-time">
                  {formatDateTime(r.createdAt)}
                </div>
                {r.reviewNote && (
                  <div className="role-request-note">审批：{r.reviewNote}</div>
                )}
              </div>
              <span className={`role-status role-${r.status}`}>
                {statusLabel(r.status)}
              </span>
            </div>
          ))}
        </div>
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

function statusLabel(s) {
  return { pending: '待审批', approved: '已通过', rejected: '已拒绝' }[s] || s;
}