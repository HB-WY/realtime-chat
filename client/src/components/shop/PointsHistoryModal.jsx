// client/src/components/shop/PointsHistoryModal.jsx
//
// 【本次改动】reasonLabel 补上支付系统新增的 reason：
//   transfer_send / transfer_accept / transfer_refund
//   transfer_hold / transfer_release
//   redpacket_send / redpacket_receive / redpacket_refund
//   redpacket_hold / redpacket_release
//   否则流水里会直接显示英文原始值。
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState } from 'react';
import { getMyPoints, getPointsHistory } from '../../api';
import { formatDateTime } from '../../utils/timeUtils';

export default function PointsHistoryModal({ onClose }) {
  const [balance, setBalance] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([getMyPoints(), getPointsHistory(100)])
      .then(([b, h]) => {
        if (!alive) return;
        setBalance(b.balance);
        setRows(h.transactions || []);
      })
      .catch((err) => {
        // 不要静默吞掉错误，否则余额会一直显示「—」且用户不知道发生了什么
        if (alive) setError(err?.message || '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 480 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">我的积分</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="points-big">
          <span className="points-big-value">{balance ?? '—'}</span>
          <span className="points-big-label">积分余额</span>
        </div>

        <div className="modal-label">最近流水</div>
        {error && <div className="auth-error">{error}</div>}
        <div className="points-list">
          {loading && <div className="modal-empty">加载中...</div>}
          {!loading && rows.length === 0 && (
            <div className="modal-empty">暂无记录</div>
          )}
          {rows.map((r) => (
            <div key={r.id} className="points-row">
              <div className="points-row-main">
                <div className="points-row-reason">{reasonLabel(r.reason)}</div>
                {r.note && <div className="points-row-note">{r.note}</div>}
                <div className="points-row-time">
                  {formatDateTime(r.createdAt)}
                </div>
              </div>
              <div
                className={`points-row-delta ${
                  r.delta >= 0 ? 'plus' : 'minus'
                }`}
              >
                {r.delta >= 0 ? '+' : ''}
                {r.delta}
              </div>
              <div className="points-row-balance">= {r.balanceAfter}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function reasonLabel(r) {
  return (
    {
      // 原有
      signup: '注册赠送',
      purchase: '购买商品',
      sale: '卖出商品',
      admin_grant: '管理员发放',
      refund: '退款',

      // 【新增】转账（成对：send/accept 或 send/refund；hold/release 是官方托管侧）
      transfer_send: '转出',
      transfer_accept: '收款',
      transfer_refund: '转账退还',
      transfer_hold: '（托管）',
      transfer_release: '（托管释放）',

      // 【新增】红包（同上）
      redpacket_send: '发红包',
      redpacket_receive: '抢到红包',
      redpacket_refund: '红包退回',
      redpacket_hold: '（托管）',
      redpacket_release: '（托管释放）'
    }[r] || r
  );
}