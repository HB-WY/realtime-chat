// client/src/components/plugins/PluginUploadDialog.jsx
//
// 上传 / 更新 .plugin 文件。
//
// ============================================================
// 【本次改动 · 提示语重写（适配 v3 多页面架构）】
// ============================================================
//   · 原提示 "manifest.json + index.html + style.css + app.js"
//     是单页时代的暗示 —— v3 支持多页面（manifest.pages[]），必须明确
//   · 原提示没提 entry 必须在 pages 里（上传会被服务端硬拒）
//   · 原提示没提"更新版本走同一入口"（改 manifest.version 即可）
//   · 删掉独立的"代理白名单"段（绝大多数上传者用不到，干扰信息）
//   · 加"打包命令一行" 的模板，让首次上传的人能直接照抄
//   · 明确「相对路径从资源根算」这个最大的坑
//
// ============================================================
// 【历史改动 · 版本更新】
// ============================================================
//   · 支持 changelog 输入（写进 plugin_versions 表，展示在详情对话框）
//
// ============================================================
// 【历史改动 · 白名单独立化】
// ============================================================
//   · 删掉了「Proxy 白名单」输入框 —— 由运维通过
//     server/plugin-whitelist.yaml 管理，上传者无法自行扩权
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useRef, useState } from 'react';
import { publishPlugin, uploadAvatar } from '../../api';

// 前端预检大小（服务端上限由 config.yaml → plugins.max_bundle_bytes 决定）
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export default function PluginUploadDialog({ role, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [icon, setIcon] = useState(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const iconRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const pickFile = () => fileRef.current?.click();
  const pickIcon = () => iconRef.current?.click();

  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.name.endsWith('.plugin')) {
      setError('文件必须以 .plugin 结尾');
      return;
    }
    if (f.size > MAX_PREVIEW_BYTES) {
      setError(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB）`);
      return;
    }
    setError('');
    setFile(f);
  };

  const onIconChange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    setIconUploading(true);
    try {
      const res = await uploadAvatar(f);
      setIcon({ url: res.url });
    } catch (err) {
      setError(err.message || '图标上传失败');
    } finally {
      setIconUploading(false);
    }
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const d = await publishPlugin(file, {
        isPublic,
        iconUrl: icon?.url || undefined,
        changelog: changelog.trim() || undefined
      });
      onUploaded?.(d?.plugin || null);
    } catch (err) {
      setError(err.message || '上传失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal-card plg-modal-upload"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">上传小程序</span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {/* ============================================================
            打包说明
            ------------------------------------------------------------
            [本次改动] 重写这段。原文本假设单页（index.html + style.css + app.js），
            与实际多页面架构不符；也没有提醒"更新版本"和"entry 必须在 pages 里"。
            ============================================================ */}
        <div className="plg-upload-hint">
          <div style={{ fontWeight: 600, color: '#333', marginBottom: 6 }}>
            项目目录打包成 <code>.plugin</code>：
          </div>
          <pre
            style={{
              margin: '6px 0',
              padding: '8px 10px',
              background: '#f6f8fa',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: 'auto'
            }}
          >
            <code>{`cd plugins-demo
node pack-plugin.mjs <你的插件目录>`}</code>
          </pre>

          <div style={{ marginTop: 8 }}>
            <b>目录结构</b>（最小可用）：
          </div>
          <pre
            style={{
              margin: '4px 0 8px',
              padding: '8px 10px',
              background: '#f6f8fa',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: 'auto'
            }}
          >
            <code>{`<id>/
├── manifest.json
├── pages/<页名>/<页名>.html   ← 至少 1 个页面
├── pages/<页名>/<页名>.css    （可选）
├── pages/<页名>/<页名>.js     （可选）
└── lib/                       （可选，共享模块）`}</code>
          </pre>

          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>
              <code>manifest.pages</code> 里每个页面路径都要存在，且
              <code>manifest.entry</code> 必须出现在 pages 里
            </li>
            <li>
              CSS / JS 直接写相对路径即可（服务端注入 <code>&lt;base&gt;</code>，
              不用手工拼 ticket）。<b>相对路径要从"资源根"算</b>，不是从当前
              HTML 文件算 —— 例如 <code>pages/chat/index.html</code> 引同目录 CSS
              要写 <code>pages/chat/index.css</code>
            </li>
            <li>
              <b>更新版本</b>：同 id 覆盖上传，记得把 <code>manifest.version</code>
              从 <code>x.y.z</code> 增大（比如 <code>3.0.0 → 3.0.1</code>）；
              版本号变小会被拒绝
            </li>
            <li>
              代理白名单（可选）：由运维在 <code>server/plugin-whitelist.yaml</code>
              里配置，<b>不在本对话框填</b>
            </li>
          </ul>
        </div>

        {/* ---------- 图标（可选） ---------- */}
        <label className="modal-label">图标（可选）</label>
        <div className="plg-icon-pick">
          <button
            type="button"
            className={`plg-icon-preview ${icon ? 'has-icon' : ''}`}
            onClick={pickIcon}
            disabled={busy || iconUploading}
            title="点击上传图标"
          >
            {icon?.url ? (
              <img src={icon.url} alt="图标预览" />
            ) : (
              <span className="plg-icon-placeholder">+</span>
            )}
          </button>
          <div className="plg-icon-side">
            <div className="plg-icon-tip">
              建议 128×128 或更大的正方形图片。<br />
              不传则回落到小程序名称首字。
            </div>
            {icon && (
              <button
                type="button"
                className="plg-icon-remove"
                onClick={() => setIcon(null)}
                disabled={busy}
              >
                清除图标
              </button>
            )}
          </div>
          <input
            ref={iconRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onIconChange}
          />
        </div>

        {/* ---------- 插件包 ---------- */}
        <label className="modal-label">小程序包文件</label>
        <button
          type="button"
          className={`plg-file-pick ${file ? 'has-file' : ''}`}
          onClick={pickFile}
          disabled={busy}
        >
          <span className="plg-card-icon" style={{ width: 32, height: 32, fontSize: 14 }}>
            +
          </span>
          <span className="plg-file-meta">
            <span className="plg-file-name">
              {file ? file.name : '点击选择 .plugin 文件'}
            </span>
            <span className="plg-file-sub">
              {file
                ? `${(file.size / 1024).toFixed(1)} KB`
                : `最大 ${(MAX_PREVIEW_BYTES / 1024 / 1024).toFixed(0)} MB`}
            </span>
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".plugin,application/json"
          hidden
          onChange={onFileChange}
        />

        {/* ---------- 更新说明 ---------- */}
        <label className="modal-label" style={{ marginTop: 12 }}>
          更新说明（可选，会记录到版本历史）
        </label>
        <textarea
          className="auth-input"
          rows={2}
          maxLength={2000}
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          placeholder="例如：修复了 XX 问题 / 新增 XX 功能"
          disabled={busy}
          style={{ resize: 'vertical', minHeight: 50, fontSize: 13 }}
        />

        {/* ---------- 可见性 ---------- */}
        <label className="modal-label" style={{ marginTop: 12 }}>
          可见性
        </label>
        <div className="market-picker">
          <button
            type="button"
            className={`market-choice ${!isPublic ? 'active' : ''}`}
            onClick={() => setIsPublic(false)}
            disabled={busy}
          >
            <div className="market-choice-name">私有</div>
            <div className="market-choice-tip">只有你能看到和使用；可随时生成分享码</div>
          </button>
          <button
            type="button"
            className={`market-choice ${isPublic ? 'active' : ''}`}
            onClick={() => setIsPublic(true)}
            disabled={busy}
          >
            <div className="market-choice-name">公开</div>
            <div className="market-choice-tip">所有用户都能在「发现」看到并安装</div>
          </button>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button
            className="auth-submit"
            onClick={submit}
            disabled={busy || !file || iconUploading}
          >
            {busy ? '上传中…' : iconUploading ? '图标上传中…' : '上传'}
          </button>
        </div>
      </div>
    </div>
  );
}