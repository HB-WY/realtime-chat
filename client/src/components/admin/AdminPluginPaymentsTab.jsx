// client/src/components/admin/AdminPluginPaymentsTab.jsx
//
// 管理面板 · 插件支付流水。
//
//   · 按状态筛选（全部 / 已付 / 已退款）
//   · 按插件 id 筛选
//   · 展示：插件、买家、卖家、金额、状态、时间、退款原因
//   · 强制退款（不受 7 天窗口限制）
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useState } from 'react';
import {
  adminListPluginPayments,
  adminRefundPluginPayment
} from '../../api';
import { formatShortDateTime } from '../../utils/timeUtils';

const STATUS_TABS = [
  { key: '',         label: '全部' },
  { key: 'paid',     label: '已支付' },
  { key: 'refunded', label: '已退款' }
];

export default function AdminPluginPaymentsTab() {
  const [tab, setTab] = useState('');
  const [pluginFilter, setPluginFilter] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await adminListPluginPayments({
        status: tab,
        pluginId: pluginFilter.trim() || undefined,
        limit: 300
      });
      setItems(d.payments || []);
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

  const handleRefund = async (pay) => {
    const reason = prompt(
      `强制退款 ${pay.amount} 积分给「${pay.buyerName || '#' + pay.buyerId}」？\n` +
      `（从插件「${pay.pluginName}」的作者账户扣回）\n\n退款原因：`,
      '管理员退款'
    );
    if (reason === null) return;
    try {
      await adminRefundPluginPayment(pay.id, reason || '管理员退款');
      alert('已退款');
      load();
    } catch (err) {
      alert(err.message || '退款失败');
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="search-row">
        <input
          className="auth-input"
          value={pluginFilter}
          onChange={(e) => setPluginFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
          placeholder="按插件 id 筛选（留空 = 全部）"
        />
        <button className="auth-submit" style={{ width: 100, marginTop: 0 }} onClick={load}>
          筛选
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
        <div className="modal-empty">暂无支付记录</div>
      )}

      <div className="admin-list">
        {items.map((pay) => {
          const refunded = pay.status === 'refunded';
          return (
            <div key={pay.id} className="admin-user-row">
              <div className="admin-user-info">
                <div className="admin-user-name">
                  <span className="ak-mono">{pay.transactionId}</span>
                  <span className={`plg-pay-item-status ${refunded ? 'refunded' : 'paid'}`}>
                    {refunded ? '已退款' : '已支付'}
                  </span>
                </div>
                <div className="admin-user-sub">
                  插件「{pay.pluginName}」 · {pay.subject}
                </div>
                <div className="admin-user-sub">
                  买家 {pay.buyerName || `#${pay.buyerId}`}
                  {' → '}
                  卖家 {pay.sellerName || `#${pay.sellerId}`}
                  {' · '}
                  <b style={{ color: refunded ? '#999' : '#e67e22' }}>
                    {pay.amount} 积分
                  </b>
                </div>
                <div className="admin-user-sub">
                  支付 {formatShortDateTime(pay.paidAt || pay.createdAt)}
                  {refunded && ` · 退款 ${formatShortDateTime(pay.refundedAt)}`}
                  {refunded && pay.refundReason && ` · 原因：${pay.refundReason}`}
                </div>
              </div>
              <div className="admin-user-actions">
                {!refunded && (
                  <button className="mini-btn danger" onClick={() => handleRefund(pay)}>
                    强制退款
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