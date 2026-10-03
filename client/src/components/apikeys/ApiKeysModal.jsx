import { useEffect, useRef, useState } from 'react';
import { createApiKey, listApiKeys, revokeApiKey } from '../../api';
import { formatDateTime } from '../../utils/timeUtils';

/**
 * 我的 API 密钥弹窗（第二认证通道，独立于浏览器 JWT/Cookie）。
 *
 * 明文密钥只在申请成功时由服务端返回一次，之后只剩前缀与哈希，
 * 因此这里必须把「只显示一次」讲清楚，并在关闭/重新申请时丢掉明文。
 *
 * 【本次修复】申请中（creating === true）禁止关闭弹窗：
 *   原实现里遮罩 / ✕ / Esc 三个出口都没拦 —— 用户在请求在飞时点 ✕，
 *   弹窗立即卸载，setOnce(d) 永远没有机会执行；而服务端已经生成了一把
 *   可用密钥，用户却看不到明文，与「只显示这一次」的承诺矛盾。
 *   现在三处都加了 !creating 判定，与 UploadProductModal / RoleRequestModal
 *   的做法保持一致。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 * [FIX] 删掉无用的 eslint-disable 注释 —— 改造后 load() 不再依赖外部变量。
 */
export default function ApiKeysModal({ onClose }) {
  const [keys, setKeys] = useState([]);
  const [max, setMax] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [once, setOnce] = useState(null); // 刚申请到的明文密钥（一次性）
  const [copied, setCopied] = useState(false);
  const onceRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const d = await listApiKeys();
      setKeys(d.keys || []);
      setMax(typeof d.max === 'number' ? d.max : null);
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Esc 关闭
  // [FIX] 申请中不响应 Esc：否则请求还在飞，用户按 Esc 关掉弹窗，
  //   服务端已下发的明文密钥就永远拿不到了。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !creating) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, creating]);

  // 已撤销：服务端同时给出 revokedAt 与 status，两者任一命中都算撤销
  const isRevoked = (k) => !!k.revokedAt || k.status === 'revoked';
  const activeCount = keys.filter((k) => !isRevoked(k)).length;
  const maxReached = max !== null && activeCount >= max;

  const dismissOnce = () => {
    setOnce(null);
    setCopied(false);
  };

  const apply = async () => {
    if (maxReached) {
      alert(`最多同时持有 ${max} 个有效密钥，请先撤销不再使用的密钥。`);
      return;
    }
    setCreating(true);
    // 申请新密钥时清掉上一次的明文，避免用户复制到旧值
    setOnce(null);
    setCopied(false);
    try {
      const d = await createApiKey(name.trim());
      setOnce(d);
      setName('');
      await load();
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setCreating(false);
    }
  };

  const copyOnce = async () => {
    if (!once) return;
    try {
      await navigator.clipboard.writeText(once.key);
      setCopied(true);
    } catch {
      // 非 https / 无剪贴板权限时退化为手动复制
      onceRef.current?.select();
      alert('复制失败，已为你选中密钥，请按 Ctrl+C 手动复制。');
    }
  };

  const revoke = async (k) => {
    const label = k.name || '未命名';
    if (!confirm(`确定撤销密钥「${label}」？撤销后使用该密钥的脚本会立即失效。`)) {
      return;
    }
    try {
      const d = await revokeApiKey(k.id);
      let msg = '密钥已撤销。';
      if (d && d.ipBindingKept) {
        msg +=
          '\n\n该密钥的 IP 绑定被有意保留：撤销密钥不会释放 IP 绑定，只有管理员可以释放。';
      }
      alert(msg);
      await load();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  // 申请中禁止通过遮罩 / ✕ 关闭（同 Esc 的处理），避免丢掉一次性明文
  const handleOverlayClose = () => {
    if (creating) return;
    onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={handleOverlayClose}>
      <div
        className="modal-card ak-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">API 密钥</span>
          <button className="icon-btn" onClick={onClose} disabled={creating}>
            ✕
          </button>
        </div>

        {/* 一次性明文密钥：最显眼的位置，可手动关闭 */}
        {once && (
          <div className="ak-once">
            <div className="ak-once-title">⚠️ 明文密钥只显示这一次</div>
            <div className="ak-once-sub">
              服务端只保存它的哈希与 12 位前缀（
              <span className="ak-mono">{once.prefix}</span>
              ），关闭本窗口后无法再次查看。请立即复制并妥善保存。
            </div>
            <div className="ak-once-row">
              <input
                ref={onceRef}
                className="ak-once-input ak-key"
                readOnly
                value={once.key}
                onFocus={(e) => e.target.select()}
              />
              <button className="ak-copy-btn" onClick={copyOnce}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            {once.notice && <div className="ak-once-note">{once.notice}</div>}
            {once.boundIp && (
              <div className="ak-once-note">
                已绑定 IP：<span className="ak-mono">{once.boundIp}</span>
                （同一 IP 只能绑定一个账号）
              </div>
            )}
            <div className="ak-once-actions">
              <button className="btn-secondary" onClick={dismissOnce}>
                我已保存，关闭提示
              </button>
            </div>
          </div>
        )}

        <div className="modal-label">
          我的密钥
          <span className="ak-count">
            有效 {activeCount}
            {max !== null ? ` / ${max}` : ''}
          </span>
        </div>

        <div className="list-table">
          {loading && <div className="modal-empty">加载中...</div>}
          {!loading && keys.length === 0 && (
            <div className="modal-empty">还没有密钥，可以在下面申请一个</div>
          )}
          {keys.map((k) => {
            const revoked = isRevoked(k);
            return (
              <div key={k.id} className="ak-row">
                <div className="ak-row-main">
                  <div className="ak-row-title">
                    {k.name || '未命名'}
                    <span className={`ak-tag ${revoked ? 'revoked' : 'active'}`}>
                      {revoked ? '已撤销' : '有效'}
                    </span>
                  </div>
                  <div className="ak-row-sub">
                    <span className="ak-key">{k.masked}</span>
                    <span className="ak-mono"> 前缀 {k.prefix}</span>
                  </div>
                  <div className="ak-row-sub">
                    创建时间 {formatDateTime(k.createdAt)} · 最近使用{' '}
                    {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : '从未使用'}
                  </div>
                  {k.boundIp && (
                    <div className="ak-row-sub">
                      绑定 IP <span className="ak-mono">{k.boundIp}</span>
                      <span className="ak-hint"> · 仅该 IP 可用</span>
                    </div>
                  )}
                  {k.lastIp && (
                    <div className="ak-row-sub">
                      最近来源 IP <span className="ak-mono">{k.lastIp}</span>
                    </div>
                  )}
                  {revoked && k.lastIp && (
                    <div className="ak-warn">
                      IP 绑定保留：该 IP 仍绑定在本账号，撤销密钥不会释放它，需管理员手动释放。
                    </div>
                  )}
                </div>
                <div className="ak-row-actions">
                  {!revoked && (
                    <button className="btn-danger-mini" onClick={() => revoke(k)}>
                      撤销
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-label">申请新密钥</div>
        <div className="ak-toolbar">
          <input
            className="auth-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !creating && !maxReached) apply();
            }}
            placeholder="密钥名称，例如：我的同步脚本"
            maxLength={40}
          />
          <button
            className="auth-submit ak-apply"
            onClick={apply}
            disabled={creating || maxReached}
          >
            {creating ? '申请中...' : '申请密钥'}
          </button>
        </div>
        {maxReached && (
          <div className="ak-warn">
            已达到上限（{max} 个有效密钥），请先撤销不用的密钥再申请。
          </div>
        )}

        <div className="modal-label">命令行调用</div>
        <div className="ak-help">
          <pre>
            <code>{`curl -H "X-API-Key: rk_..." http://<host>:3001/api/v1/state

curl -H "X-API-Key: rk_..." -H "Content-Type: application/json" -d '{"roomType":"public","roomId":"public","text":"hi"}' http://<host>:3001/api/v1/messages`}</code>
          </pre>
          <ul>
            <li>浏览器能调用的接口，这条通道都能调用，把 /api/... 换成 /api/v1/... 即可。</li>
            <li>/api/v1 下的请求必须携带 X-API-Key 请求头，缺少或无效会返回 401。</li>
            <li>请求按密钥独立限流，超限会返回 429，请不要高频轮询。</li>
            <li>账号被封禁后，它名下的所有密钥会立即失效。</li>
            <li>明文密钥只在这里显示一次，请立即保存；泄露后请马上撤销并重新申请。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}