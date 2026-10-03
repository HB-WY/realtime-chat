// client/src/components/plugins/PluginPayDialog.jsx
//
// 宿主侧的**支付确认框** —— 整个插件支付安全模型里最关键的一环。
//
// 为什么必须在宿主侧：
//   插件画的 UI 不可信（它可以把"支付 1000"按钮画成"支付 1"，
//   把"取消"按钮画成"确认"）。用户看到的是**宿主**弹的框，展示的是
//   **宿主**从服务端拿到的事实（金额、余额、卖家、上限）。
//
// 三件事：
//   · 展示 amount / subject / 当前余额 / 支付后余额
//   · 展示单次上限 + **今日已用笔数**（都来自服务端）
//   · 用户点"确认支付"才 resolve(true)
//
// [CHANGED] 认证改造：本组件是**纯 UI**，不涉及认证/网络。
//   它在 ChatRoom 里由 handlePluginPayment 弹出，onConfirm / onCancel
//   由父组件控制 —— 认证改造对这里没有影响。
//
// [CHANGED] 每日限制从"金额"改为"笔数"：
//   · 原字段 dailyRemain（积分）→ 改为 dailyCountUsed / dailyCountMax /
//     dailyCountRemain 三件套
//   · 展示从"今日剩余额度 X 积分"改为"今日支付次数 X / Y 次"
//   · 判断从 amount > dailyRemain 改为 dailyCountRemain <= 0
//   详见 services/pluginPayments.js 顶部 [CHANGED] 说明。
//
import { useEffect } from 'react';

export default function PluginPayDialog({ info, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (!info) return null;

  const {
    pluginName, amount, subject, balance, singleMax,
    dailyCountUsed, dailyCountMax, dailyCountRemain
  } = info;

  const after = Number.isFinite(balance) ? balance - amount : null;

  // 三种"被挡"情形，任一命中则 disable 确认按钮
  const willExceedSingle = Number.isFinite(singleMax) && amount > singleMax;
  const willExceedDailyCount = Number.isFinite(dailyCountRemain) && dailyCountRemain <= 0;
  const willExceedBalance = Number.isFinite(balance) && amount > balance;
  const blocked = willExceedSingle || willExceedDailyCount || willExceedBalance;

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal-card plg-modal-pay"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">确认支付</span>
          <button className="icon-btn" onClick={onCancel}>✕</button>
        </div>

        <div className="plg-pay-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="plg-pay-amount">
              - {amount} <span style={{ fontSize: 14, fontWeight: 600 }}>积分</span>
            </div>
            <div className="plg-pay-subject">
              {pluginName ? `「${pluginName}」 · ` : ''}{subject}
            </div>
          </div>
        </div>

        <div className="plg-pay-meta">
          <div className="plg-pay-row">
            <span>当前余额</span>
            <strong>{Number.isFinite(balance) ? balance : '—'} 积分</strong>
          </div>
          <div className="plg-pay-row">
            <span>支付后余额</span>
            <strong style={{ color: after !== null && after < 0 ? '#e74c3c' : undefined }}>
              {after !== null ? after : '—'} 积分
            </strong>
          </div>
          {Number.isFinite(singleMax) && (
            <div className="plg-pay-row">
              <span>单次上限</span>
              <strong>{singleMax} 积分</strong>
            </div>
          )}
          {/* [CHANGED] 展示"今日支付次数"，替代原"今日剩余额度（积分）" */}
          {Number.isFinite(dailyCountMax) && (
            <div className="plg-pay-row" title="针对本小程序的每日支付笔数上限">
              <span>今日支付次数</span>
              <strong>
                {dailyCountUsed ?? 0} / {dailyCountMax} 次
              </strong>
            </div>
          )}
        </div>

        {blocked && (
          <div className="plg-pay-warn">
            {willExceedSingle && <div>· 单次金额超过上限（{singleMax}）</div>}
            {willExceedDailyCount && (
              <div>· 今日对该小程序的支付次数已达上限（{dailyCountMax} 次）</div>
            )}
            {willExceedBalance && <div>· 积分余额不足</div>}
          </div>
        )}

        <div className="plg-pay-warn" style={{ background: '#f0f7ff', borderColor: '#cfe0f8', color: '#1e3a8a' }}>
          支付会从你的积分余额直接扣除。若插件后续出现异常，可在
          「账户 → 积分流水」里申请退款（7 天内）。超过 7 天需联系管理员。
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="auth-submit"
            onClick={() => !blocked && onConfirm()}
            disabled={blocked}
          >
            {blocked ? '无法支付' : `确认支付 ${amount} 积分`}
          </button>
        </div>
      </div>
    </div>
  );
}