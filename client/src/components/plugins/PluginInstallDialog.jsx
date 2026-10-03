// client/src/components/plugins/PluginInstallDialog.jsx
//
// 安装确认卡：
//   · 展示 manifest 声明的权限（用户可逐项取消勾选 —— 取消即不授权）
//   · 权限说明写在本地映射表里（不是后端下发，避免后端被攻破后随便改文案）
//   · payment:request 用醒目样式提示（danger 类）
//
// [CHANGED] 认证改造：不再接收 token prop。
//   · installPlugin(id, grantedPerms) —— 2 个参数（旧版是 3 个：token 在第一位）
//   · 如果这里还传 token，会变成 installPlugin(undefined, plugin.id)，
//     最终请求打到 /api/plugins/undefined/install → 404 插件不存在
//
import { useEffect, useMemo, useState } from 'react';
import { installPlugin } from '../../api';

// 权限的中文说明。如果后端新增了权限但这里没列，会 fallback 到 key 本身。
const PERM_LABEL = {
  'user:read':       { label: '读取你的昵称和头像', desc: '仅用于向插件展示' },
  'user:friends':    { label: '读取你的好友列表', desc: '昵称和头像' },
  'room:list':       { label: '读取你的会话列表', desc: '不含消息内容' },
  'message:send':    { label: '向会话发送消息', desc: '以你的身份发出' },
  'storage':         { label: '保存它自己的数据', desc: '与其他插件隔离，每个用户一份' },
  'ui:toast':        { label: '弹出通知提示', desc: '显示在页面右下角' },
  'ui:close':        { label: '关闭自己', desc: '返回聊天界面' },
  'payment:request': { label: '发起积分支付请求', desc: '每次都由你确认后才扣款', danger: true }
};

function permInfo(key) {
  return PERM_LABEL[key] || { label: key, desc: '' };
}

export default function PluginInstallDialog({ plugin, onClose, onInstalled }) {
  const perms = useMemo(
    () => (Array.isArray(plugin?.permissions) ? plugin.permissions : []),
    [plugin]
  );
  const [granted, setGranted] = useState(() => new Set(perms));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // 打开对话框时默认勾选所有声明的权限
    setGranted(new Set(perms));
  }, [perms]);

  const toggle = (key) => {
    setGranted((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      // [CHANGED] 2 个参数：id 在第一位，grantedPerms 在第二位。
      //   旧版是 installPlugin(token, plugin.id, ...)，改造后 token 已不存在，
      //   继续用旧签名会让 id=undefined → 请求打到 /api/plugins/undefined/install。
      const d = await installPlugin(plugin.id, Array.from(granted));
      onInstalled?.(d?.plugin || null);
    } catch (err) {
      setError(err.message || '安装失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal-card plg-modal-install"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">安装插件</span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="group-info-head" style={{ paddingBottom: 10 }}>
          <span className="plg-card-icon" style={{ width: 56, height: 56, fontSize: 24 }}>
            {plugin?.iconUrl
              ? <img src={plugin.iconUrl} alt="" />
              : (plugin?.name || '?').slice(0, 1)}
          </span>
          <div className="group-info-name">{plugin?.name}</div>
          <div className="group-info-sub">
            v{plugin?.version} · {plugin?.description || '无描述'}
          </div>
        </div>

        <label className="modal-label">
          「{plugin?.name}」想获得以下权限
          <span style={{ fontWeight: 400, color: '#888', marginLeft: 6 }}>
            （取消勾选 = 不授权）
          </span>
        </label>

        {perms.length === 0 ? (
          <div className="modal-empty">这个插件不需要任何权限</div>
        ) : (
          <div className="plg-perm-list">
            {perms.map((key) => {
              const info = permInfo(key);
              const on = granted.has(key);
              return (
                <label
                  key={key}
                  className={`plg-perm-item ${info.danger ? 'danger' : ''}`}
                  style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
                >
                  <span className={`plg-perm-check ${on ? 'on' : ''}`}>
                    {on ? '✓' : ''}
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </span>
                  <div className="plg-perm-body">
                    <div className="plg-perm-label">{info.label}</div>
                    {info.desc && <div className="plg-perm-desc">{info.desc}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="auth-submit" onClick={submit} disabled={busy}>
            {busy ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  );
}