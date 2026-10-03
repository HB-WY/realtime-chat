// client/src/components/payments/RedPacketDialog.jsx
//
// 发红包的弹窗。
//   · 群聊：可以选拼手气 / 固定金额，份数自由（1-100）
//   · 私聊：强制"固定 / 1 份"（一对一红包）
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState } from 'react';
import { createRedPacket } from '../../api';

const MODE_LUCKY = 'lucky';
const MODE_FIXED = 'fixed';

export default function RedPacketDialog({
  roomType, roomId, onClose, onCreated
}) {
  const isGroup = roomType === 'group';
  const [mode, setMode] = useState(isGroup ? MODE_LUCKY : MODE_FIXED);
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState(isGroup ? '10' : '1');
  const [note, setNote] = useState('恭喜发财，大吉大利');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const totalNum = Number(amount);
  const cntNum = Number(count);
  const per = cntNum > 0 && totalNum > 0
    ? (mode === MODE_FIXED ? Math.floor(totalNum / cntNum) : null)
    : null;

  const submit = async () => {
    setError('');
    if (!Number.isInteger(totalNum) || totalNum < 1) {
      setError('请输入整数金额');
      return;
    }
    if (!Number.isInteger(cntNum) || cntNum < 1 || cntNum > 100) {
      setError('份数需为 1-100');
      return;
    }
    if (totalNum < cntNum) {
      setError('总金额不能小于份数');
      return;
    }
    setBusy(true);
    try {
      const d = await createRedPacket({
        roomType, roomId,
        totalAmount: totalNum,
        count: cntNum,
        mode,
        note: note.trim()
      });
      onCreated?.(d);
      onClose();
    } catch (err) {
      setError(err.message || '发红包失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="modal-card pay-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{isGroup ? '发群红包' : '发红包'}</span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {/* 模式选择：私聊强制固定 */}
        {isGroup && (
          <div className="pay-mode-picker">
            <button
              type="button"
              className={`pay-mode-choice ${mode === MODE_LUCKY ? 'active' : ''}`}
              onClick={() => setMode(MODE_LUCKY)}
              disabled={busy}
            >
              拼手气红包
            </button>
            <button
              type="button"
              className={`pay-mode-choice ${mode === MODE_FIXED ? 'active' : ''}`}
              onClick={() => setMode(MODE_FIXED)}
              disabled={busy}
            >
              普通红包
            </button>
          </div>
        )}

        <div className="pay-dialog-amount-wrap">
          <div className={`pay-dialog-amount ${totalNum > 10000 ? 'over' : ''}`}>
            <input
              type="number"
              min={1}
              max={10000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              autoFocus
              style={{
                border: 0, outline: 0, background: 'transparent',
                fontSize: 40, fontWeight: 800, width: '100%',
                textAlign: 'center', fontVariantNumeric: 'tabular-nums'
              }}
              disabled={busy}
            />
          </div>
        </div>
        {mode === MODE_LUCKY && (
          <div className="pay-dialog-hint">拼手气红包，金额随机分配</div>
        )}
        {mode === MODE_FIXED && isGroup && per != null && per > 0 && (
          <div className="pay-dialog-hint">每份 {per} 积分（余数并入最后一份）</div>
        )}
        {mode === MODE_FIXED && !isGroup && (
          <div className="pay-dialog-hint">一对一红包，只有对方能领</div>
        )}

        <div className="pay-dialog-fields">
          {isGroup && (
            <div className="pay-dialog-row">
              <label>个数</label>
              <input
                className="auth-input"
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <div className="pay-dialog-row">
            <label>祝福语</label>
            <input
              className="auth-input"
              value={note}
              maxLength={20}
              onChange={(e) => setNote(e.target.value)}
              placeholder="恭喜发财，大吉大利"
              disabled={busy}
            />
          </div>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button
            className="auth-submit"
            style={{ background: '#d93a2b', borderColor: '#d93a2b' }}
            onClick={submit}
            disabled={busy || !amount}
          >
            {busy ? '处理中…' : `塞入红包（${totalNum || 0} 积分）`}
          </button>
        </div>
      </div>
    </div>
  );
}