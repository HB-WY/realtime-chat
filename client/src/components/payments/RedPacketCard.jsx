// client/src/components/payments/RedPacketCard.jsx
//
// 聊天里的红包卡片。
//
// 生命周期：
//   1) 挂载时 GET /api/redpackets/:id 拉详情（含 who-grabbed-what）
//   2) 监听 socket 事件更新本地状态：
//        redpacket:grabbed —— 有人抢了（更新剩余份数）
//        redpacket:expired —— 过期退回（卡变灰）
//   3) 点"拆" → socket.emit('redpacket:grab', ...) → 回调里更新
//
// [NOTE] 卡片自己负责拉数据和订阅事件，宿主（MessageBubble）只传 id。
// 这样聊天列表里有多条红包消息时，各自独立、互不干扰。
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState, useCallback } from 'react';
import { getRedPacket as fetchRedPacket } from '../../api';

function RedPacketIcon({ size = 30 }) {
  // 微信红包样式：红信封 + 金色封口
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M5 7a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z"
        fill="rgba(255,255,255,0.92)"
      />
      <path
        d="M5 7a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v3.5c-3.6 1.8-8 2.8-12 2.8s-8.4-1-12-2.8Z"
        fill="#ffd15c"
      />
      <circle cx="16" cy="10.5" r="2.4" fill="#e8b437" />
      <path
        d="M14.6 10.5h2.8M16 9.1v2.8"
        stroke="#fff"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function RedPacketCard({
  redPacketId,
  isSelf,
  currentUserId,
  socket
}) {
  const [rp, setRp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [grabResult, setGrabResult] = useState(null); // { amount } | { error }
  const [detailOpen, setDetailOpen] = useState(false);

  // 初次拉详情
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchRedPacket(redPacketId)
      .then((d) => { if (alive) setRp(d.redPacket); })
      .catch(() => { if (alive) setRp(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [redPacketId]);

  // socket 事件：有人抢 / 过期
  useEffect(() => {
    if (!socket) return undefined;

    const onGrabbed = (payload = {}) => {
      if (Number(payload.redPacketId) !== Number(redPacketId)) return;
      setRp((prev) => prev ? {
        ...prev,
        remainingAmount: payload.remainingAmount,
        remainingCount: payload.remainingCount,
        status: payload.emptied ? 'empty' : prev.status
      } : prev);
      // 如果是自己抢的（多端场景），把结果也同步上
      if (Number(payload.userId) === Number(currentUserId)) {
        setGrabResult({ amount: payload.amount });
      }
    };
    const onExpired = (payload = {}) => {
      const r = payload.redPacket || {};
      if (Number(r.id) !== Number(redPacketId)) return;
      setRp((prev) => prev ? { ...prev, status: 'expired' } : prev);
    };

    socket.on('redpacket:grabbed', onGrabbed);
    socket.on('redpacket:expired', onExpired);
    return () => {
      socket.off('redpacket:grabbed', onGrabbed);
      socket.off('redpacket:expired', onExpired);
    };
  }, [socket, redPacketId, currentUserId]);

  const doGrab = useCallback(() => {
    if (!socket || !rp) return;
    setGrabResult(null);
    socket.emit('redpacket:grab', { redPacketId: rp.id }, (ack) => {
      if (ack?.ok) {
        setGrabResult({ amount: ack.amount });
        // 从 ack 里同步剩余
        if (ack.redPacket) {
          setRp((prev) => prev ? { ...prev, ...ack.redPacket } : prev);
        }
      } else {
        setGrabResult({ error: ack?.error || '领取失败' });
      }
    });
  }, [socket, rp]);

  const openDetail = useCallback(() => {
    setDetailOpen(true);
    // 打开详情时刷新一次（拿到 grants 列表）
    fetchRedPacket(redPacketId)
      .then((d) => setRp(d.redPacket))
      .catch(() => {});
  }, [redPacketId]);

  if (loading) {
    return (
      <div className="pay-card pay-rp" style={{ opacity: 0.6 }}>
        <div className="pay-card-body">
          <span className="pay-card-icon"><RedPacketIcon /></span>
          <span className="pay-card-main">
            <span className="pay-card-title">红包</span>
            <span className="pay-card-sub">加载中…</span>
          </span>
        </div>
      </div>
    );
  }
  if (!rp) {
    return (
      <div className="pay-card pay-rp pay-rp-empty">
        <div className="pay-card-body">
          <span className="pay-card-icon"><RedPacketIcon /></span>
          <span className="pay-card-main">
            <span className="pay-card-title">红包不可用</span>
            <span className="pay-card-sub">可能已被撤回或不存在</span>
          </span>
        </div>
      </div>
    );
  }

  const isEmpty = rp.status === 'empty';
  const isExpired = rp.status === 'expired';
  const myGrab = rp.myGrant || null;
  const canGrab = !isEmpty && !isExpired
    && !myGrab
    && Number(rp.senderId) !== Number(currentUserId);

  const title = rp.note || (isSelf ? '我发出的红包' : `${rp.sender ? rp.sender.nickname : '对方'}的红包`);
  const sub = isEmpty
    ? `${rp.totalCount} 个红包已领完`
    : isExpired
      ? '红包已过期'
      : `${rp.remainingCount} / ${rp.totalCount} 个待领取`;

  return (
    <>
      <button
        type="button"
        className={`pay-card pay-rp ${(isEmpty || isExpired) ? 'pay-rp-empty' : ''}`}
        onClick={openDetail}
      >
        <div className="pay-card-body">
          <span className="pay-card-icon"><RedPacketIcon /></span>
          <span className="pay-card-main">
            <span className="pay-card-title">{title}</span>
            <span className="pay-card-sub">{sub}</span>
          </span>
        </div>
        <div className="pay-card-foot">
          {myGrab && !grabResult
            ? `已领取 ${myGrab.amount} 积分`
            : grabResult?.amount != null
              ? `你抢到 ${grabResult.amount} 积分`
              : grabResult?.error
                ? grabResult.error
                : canGrab
                  ? '点击拆红包'
                  : isEmpty || isExpired
                    ? '查看详情'
                    : '查看领取详情'}
        </div>
      </button>

      {detailOpen && (
        <RedPacketDetailModal
          redPacketId={rp.id}
          currentUserId={currentUserId}
          onClose={() => setDetailOpen(false)}
          onGrab={canGrab ? doGrab : null}
          myGrant={myGrab}
        />
      )}
    </>
  );
}

// ---------------- 详情弹窗 ----------------
function RedPacketDetailModal({
  redPacketId, currentUserId, onClose, onGrab, myGrant
}) {
  const [rp, setRp] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchRedPacket(redPacketId)
      .then((d) => { if (alive) setRp(d.redPacket); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [redPacketId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const senderName = rp?.sender?.nickname || '对方';
  const isSelf = rp && Number(rp.senderId) === Number(currentUserId);
  const grants = rp?.grants || [];

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" style={{ maxWidth: 400 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{isSelf ? '我发出的红包' : `${senderName}的红包`}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="pay-rp-detail-head">
          <div className="pay-rp-detail-from">{isSelf ? '发给' : `${senderName} 发出`}</div>
          <div className="pay-rp-detail-note">{rp?.note || '恭喜发财，大吉大利'}</div>
          <div className="pay-rp-detail-amount">
            {rp ? rp.totalAmount : '—'}<small>积分</small>
          </div>
          {rp && (
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              共 {rp.totalCount} 份 · 已领 {rp.totalCount - rp.remainingCount} 份
            </div>
          )}
          {myGrant && (
            <div className="pay-rp-detail-mine">你已领取 {myGrant.amount} 积分</div>
          )}
        </div>

        {loading && <div className="modal-empty">加载中…</div>}
        {!loading && grants.length === 0 && (
          <div className="modal-empty">还没有人领取</div>
        )}
        {!loading && grants.length > 0 && (
          <div className="pay-rp-grants">
            {grants.map((g) => (
              <div key={g.userId} className="pay-rp-grant-row">
                <span className="pay-rp-grant-name">
                  {g.nickname || `#${g.userId}`}
                  {Number(g.userId) === Number(rp?.senderId) ? '（自己）' : ''}
                </span>
                <span className="pay-rp-grant-amount">{g.amount} 积分</span>
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 14 }}>
          {onGrab && (
            <button className="auth-submit" onClick={() => { onGrab(); onClose(); }}>
              拆红包
            </button>
          )}
          {!onGrab && (
            <button className="btn-secondary" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  );
}