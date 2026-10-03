// client/src/components/payments/TransferDialog.jsx
//
// 发起转账的弹窗（从聊天输入区的 "+" 菜单进入）。
//
// 只允许私聊里转账：toUserId 由 ChatRoom 从 activeRoom.peerId 提供。
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState, useRef } from 'react';
import { createTransfer } from '../../api';
import Avatar from '../common/Avatar';

export default function TransferDialog({ peer, onClose, onCreated }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amountRef = useRef(null);

  useEffect(() => {
    amountRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const submit = async () => {
    setError('');
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 1) {
      setError('请输入整数金额');
      return;
    }
    setBusy(true);
    try {
      const d = await createTransfer({
        toUserId: peer.id,
        amount: n,
        note: note.trim()
      });
      onCreated?.(d);
      onClose();
    } catch (err) {
      setError(err.message || '转账失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="modal-card pay-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">转账</span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: '#f8f9fa', borderRadius: 10,
          marginBottom: 6
        }}>
          <Avatar name={peer.nickname} avatar={peer.avatar} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{peer.nickname}</div>
            <div style={{ fontSize: 12, color: '#999' }}>
              {peer.isFriend === false ? '非好友，谨慎转账' : '好友'}
            </div>
          </div>
        </div>

        <div className="pay-dialog-amount-wrap" style={{ position: 'relative' }}>
          <div className={`pay-dialog-amount ${Number(amount) > 10000 ? 'over' : ''}`}>
            <input
              ref={amountRef}
              type="number"
              min={1}
              max={10000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              style={{
                border: 0, outline: 0, background: 'transparent',
                fontSize: 40, fontWeight: 800, width: '100%',
                textAlign: 'center', fontVariantNumeric: 'tabular-nums'
              }}
              disabled={busy}
            />
          </div>
        </div>
        <div className="pay-dialog-hint">余额可在「积分流水」查看</div>

        <div className="pay-dialog-fields">
          <div className="pay-dialog-row">
            <label>备注</label>
            <input
              className="auth-input"
              value={note}
              maxLength={50}
              onChange={(e) => setNote(e.target.value)}
              placeholder="给 TA 留言（可选）"
              disabled={busy}
            />
          </div>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="auth-submit" onClick={submit} disabled={busy || !amount}>
            {busy ? '处理中…' : '转账'}
          </button>
        </div>
      </div>
    </div>
  );
}