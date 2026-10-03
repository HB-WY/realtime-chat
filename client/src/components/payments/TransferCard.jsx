// client/src/components/payments/TransferCard.jsx
//
// 聊天里的转账卡片。
//
// 生命周期与 RedPacketCard 对称：
//   1) 挂载时 GET /api/transfers/:id 拉详情
//   2) 监听 socket 事件：
//        transfer:accepted —— 已收款
//        transfer:rejected —— 已退还
//        transfer:expired  —— 超时退回
//   3) 接收者点"收款"/"退还" → socket.emit(...)
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState, useCallback } from 'react';
import { getTransfer } from '../../api';

function TransferIcon({ size = 30 }) {
  // 微信转账样式：钱包/箭头
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="rgba(255,255,255,0.92)" />
      <path
        d="M16 8v10M11 13l5 5 5-5"
        stroke="#d93a2b"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

const STATUS_LABEL = {
  pending: '待收款',
  accepted: '已收款',
  rejected: '已退还',
  expired: '已过期'
};

export default function TransferCard({
  transferId,
  isSelf,
  currentUserId,
  socket
}) {
  const [tr, setTr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getTransfer(transferId)
      .then((d) => { if (alive) setTr(d.transfer); })
      .catch(() => { if (alive) setTr(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [transferId]);

  useEffect(() => {
    if (!socket) return undefined;
    const patch = (payload = {}) => {
      const t = payload.transfer || {};
      if (Number(t.id) !== Number(transferId)) return;
      setTr((prev) => prev ? { ...prev, ...t } : t);
    };
    socket.on('transfer:accepted', patch);
    socket.on('transfer:rejected', patch);
    socket.on('transfer:expired',  patch);
    return () => {
      socket.off('transfer:accepted', patch);
      socket.off('transfer:rejected', patch);
      socket.off('transfer:expired',  patch);
    };
  }, [socket, transferId]);

  const accept = useCallback(() => {
    if (!socket || !tr || busy) return;
    setBusy(true);
    socket.emit('transfer:accept', { transferId: tr.id }, (ack) => {
      setBusy(false);
      if (ack?.ok && ack.transfer) setTr((prev) => ({ ...prev, ...ack.transfer }));
      else if (ack?.error) alert(ack.error);
    });
  }, [socket, tr, busy]);

  const reject = useCallback(() => {
    if (!socket || !tr || busy) return;
    if (!confirm('确定退还这笔转账？')) return;
    setBusy(true);
    socket.emit('transfer:reject', { transferId: tr.id }, (ack) => {
      setBusy(false);
      if (ack?.ok && ack.transfer) setTr((prev) => ({ ...prev, ...ack.transfer }));
      else if (ack?.error) alert(ack.error);
    });
  }, [socket, tr, busy]);

  if (loading) {
    return (
      <div className="pay-card pay-tr" style={{ opacity: 0.6 }}>
        <div className="pay-card-body">
          <span className="pay-card-icon"><TransferIcon /></span>
          <span className="pay-card-main">
            <span className="pay-card-title">转账</span>
            <span className="pay-card-sub">加载中…</span>
          </span>
        </div>
      </div>
    );
  }
  if (!tr) {
    return (
      <div className="pay-card pay-tr pay-tr-settled">
        <div className="pay-card-body">
          <span className="pay-card-icon"><TransferIcon /></span>
          <span className="pay-card-main">
            <span className="pay-card-title">转账不可用</span>
            <span className="pay-card-sub">可能已被撤回或不存在</span>
          </span>
        </div>
      </div>
    );
  }

  const settled = tr.status !== 'pending';
  const isReceiver = Number(tr.toId) === Number(currentUserId);
  const statusText = STATUS_LABEL[tr.status] || tr.status;

  return (
    <div className={`pay-card pay-tr ${settled ? 'pay-tr-settled' : ''}`}>
      <div className="pay-card-body">
        <span className="pay-card-icon"><TransferIcon /></span>
        <span className="pay-card-main">
          <span className="pay-tr-amount">{tr.amount} 积分</span>
          <span className="pay-card-sub">{tr.note || (isSelf ? '我发出的转账' : '对方发来的转账')}</span>
          <span className="pay-tr-status">{statusText}</span>
        </span>
      </div>

      {!settled && isReceiver && (
        <div className="pay-actions">
          <button
            className="pay-btn-primary"
            onClick={accept}
            disabled={busy}
          >
            {busy ? '处理中…' : '收款'}
          </button>
          <button
            className="pay-btn-ghost"
            onClick={reject}
            disabled={busy}
          >
            退还
          </button>
        </div>
      )}

      {!settled && !isReceiver && (
        <div className="pay-card-foot">等待对方收款</div>
      )}
    </div>
  );
}