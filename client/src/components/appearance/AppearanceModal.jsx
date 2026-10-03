// client/src/components/appearance/AppearanceModal.jsx
//
// 个性化设置：聊天背景 / 单房间背景 / 气泡 / 字号。
//
// 【本次改动】previewStyle 复用 usePreferences.buildAppearanceStyle：
//   原实现自己写了一份 CSS 变量计算，与 buildAppearanceStyle 不一致
//   （http(s) 背景不包 url()，导致弹窗预览与聊天区实际渲染对不上）。
//   现在只有一份计算逻辑，弹窗预览和聊天区表现完全一致。
//
// [CHANGED] 认证改造：不再接收 token prop。getPreferences / savePreferences /
//   listAssets / uploadAssets 均由 http.js 从 auth/session.js 内存里读 Access。
//
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getPreferences, savePreferences, listAssets, uploadAssets
} from '../../api';
import { resolveMediaUrl } from '../../utils/media';
import { IMAGE_ACCEPT } from '../../utils/image';
import { buildAppearanceStyle } from '../../hooks/usePreferences';

const PRESET_COLORS = [
  '#ffffff', '#f5f7fa', '#eef3f8', '#fdf6e3',
  '#e8f5e9', '#fce4ec', '#ede7f6', '#1a1a1a'
];

const BUBBLE_PRESETS = [
  { label: '默认', value: null },
  { label: '微信绿', value: { self: { bg: '#95ec69', color: '#111111', border: '#95ec69' }, other: { bg: '#ffffff', color: '#222222', border: '#e8ecf0' } } },
  { label: '暗夜', value: { self: { bg: '#2b2b2b', color: '#f5f5f5', border: '#2b2b2b' }, other: { bg: '#3a3a3a', color: '#f0f0f0', border: '#444444' } } },
  { label: '天空', value: { self: { bg: '#2196f3', color: '#ffffff', border: '#2196f3' }, other: { bg: '#e3f2fd', color: '#123', border: '#bbdefb' } } },
  { label: '圆角', value: { self: { radius: 20 }, other: { radius: 20 } } }
];

function ColorRow({ label, value, onChange }) {
  return (
    <div className="ap-row">
      <span className="ap-row-label">{label}</span>
      <input
        type="color"
        className="ap-color"
        value={value || '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        className="auth-input ap-color-text"
        value={value || ''}
        placeholder="未设置"
        onChange={(e) => onChange(e.target.value.trim() || null)}
      />
      <button className="btn-danger-mini" onClick={() => onChange(null)}>清除</button>
    </div>
  );
}

export default function AppearanceModal({ roomKey, roomLabel, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('global');

  // 服务端当前值（也是「未设置」的判定基准）
  const [globalBg, setGlobalBg] = useState(null);
  const [roomBg, setRoomBg] = useState(null);
  const [fontSize, setFontSize] = useState(null);
  const [bubble, setBubble] = useState(null);
  const [limits, setLimits] = useState({ fontMin: 12, fontMax: 20 });

  const [assets, setAssets] = useState({ background: [], bubble: [] });
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, bg, bub] = await Promise.all([
          getPreferences(),
          listAssets('background'),
          listAssets('bubble')
        ]);
        if (!alive) return;
        setGlobalBg(p.global?.background ?? null);
        setFontSize(p.global?.fontSize ?? null);
        setBubble(p.global?.bubble ?? null);
        setRoomBg(roomKey ? (p.rooms?.[roomKey]?.background ?? null) : null);
        setLimits(p.limits || { fontMin: 12, fontMax: 20 });
        setAssets({
          background: bg.assets || [],
          bubble: bub.assets || []
        });
      } catch (err) {
        if (alive) setError(err.message || '加载失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [roomKey]);

  // ---------- 实时预览用的 CSS 变量 ----------
  // [FIX] 复用 buildAppearanceStyle：整个应用只有这一份 CSS 变量计算逻辑，
  //   避免「弹窗预览」与「聊天区实际渲染」出现分歧。
  const previewStyle = useMemo(() => {
    const fake = {
      global: { background: globalBg, bubble, fontSize },
      rooms: roomKey ? { [roomKey]: { background: roomBg } } : {}
    };
    return buildAppearanceStyle(fake, roomKey);
  }, [roomKey, roomBg, globalBg, fontSize, bubble]);

  const refreshAssets = async () => {
    const [bg, bub] = await Promise.all([
      listAssets('background'),
      listAssets('bubble')
    ]);
    setAssets({ background: bg.assets || [], bubble: bub.assets || [] });
  };

  const handleUpload = async (file, kind) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadAssets([file], kind);
      await refreshAssets();
      const url = res.asset?.url;
      if (!url) return;
      if (kind === 'background') setGlobalBg(url);
      else setBubble((b) => ({ ...(b || {}), self: { ...(b?.self || {}), image: url } }));
    } catch (err) {
      alert(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        global: { background: globalBg, bubble, fontSize }
      };
      if (roomKey) payload.room = { roomKey, background: roomBg };
      const next = await savePreferences(payload);
      onSaved?.(next);
      onClose?.();
    } catch (err) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const setBubbleSide = (side, key, value) => {
    setBubble((b) => {
      const next = { ...(b || {}) };
      const s = { ...(next[side] || {}) };
      if (value === null || value === '') delete s[key];
      else s[key] = value;
      if (Object.keys(s).length === 0) delete next[side];
      else next[side] = s;
      return Object.keys(next).length ? next : null;
    });
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card ap-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">个性化设置</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div className="modal-empty">加载中...</div>
        ) : (
          <>
            <div className="ap-tabs">
              <button
                className={`ap-tab ${tab === 'global' ? 'active' : ''}`}
                onClick={() => setTab('global')}
              >
                聊天背景
              </button>
              <button
                className={`ap-tab ${tab === 'bubble' ? 'active' : ''}`}
                onClick={() => setTab('bubble')}
              >
                气泡与字号
              </button>
            </div>

            {/* ---------------- 预览 ---------------- */}
            <div className="ap-preview" style={previewStyle}>
              <div className="ap-preview-msg other">
                <div className="message-content">对方的消息长这样</div>
              </div>
              <div className="ap-preview-msg self">
                <div className="message-content">我的消息长这样</div>
              </div>
            </div>

            {error && <div className="auth-error">{error}</div>}

            {tab === 'global' && (
              <div className="ap-body">
                <label className="modal-label">全局背景（所有会话默认使用）</label>
                <div className="ap-swatches">
                  <button
                    className={`ap-swatch none ${globalBg === null ? 'active' : ''}`}
                    title="不设置"
                    onClick={() => setGlobalBg(null)}
                  >
                    默认
                  </button>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`ap-swatch ${globalBg === c ? 'active' : ''}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => setGlobalBg(c)}
                    />
                  ))}
                </div>

                <ColorRow
                  label="自定义颜色"
                  value={globalBg && globalBg.startsWith('#') ? globalBg : null}
                  onChange={setGlobalBg}
                />

                {assets.background.length > 0 && (
                  <>
                    <label className="modal-label">我的背景素材（含商城购买的）</label>
                    <div className="ap-asset-grid">
                      {assets.background.map((a) => (
                        <button
                          key={a.id}
                          className={`ap-asset ${globalBg === a.url ? 'active' : ''}`}
                          title={a.name}
                          onClick={() => setGlobalBg(a.url)}
                        >
                          <img src={resolveMediaUrl(a.url)} alt={a.name} />
                        </button>
                      ))}
                    </div>
                  </>
                )}

                <div className="ap-row">
                  <button
                    className="btn-secondary"
                    style={{ flex: 'none', padding: '6px 14px', fontSize: 13 }}
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? '上传中...' : '上传背景图片'}
                  </button>
                  <span className="ap-hint">手机相册 / 拍照均可 · 大图自动压缩</span>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept={IMAGE_ACCEPT}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    handleUpload(f, 'background');
                  }}
                />

                {roomKey && (
                  <>
                    <label className="modal-label">
                      本会话背景（{roomLabel || roomKey}）—— 优先于全局背景
                    </label>
                    <div className="ap-swatches">
                      <button
                        className={`ap-swatch none ${roomBg === null ? 'active' : ''}`}
                        onClick={() => setRoomBg(null)}
                      >
                        跟随全局
                      </button>
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          className={`ap-swatch ${roomBg === c ? 'active' : ''}`}
                          style={{ background: c }}
                          title={c}
                          onClick={() => setRoomBg(c)}
                        />
                      ))}
                    </div>
                    <ColorRow
                      label="自定义颜色"
                      value={roomBg && roomBg.startsWith('#') ? roomBg : null}
                      onChange={setRoomBg}
                    />
                    {assets.background.length > 0 && (
                      <div className="ap-asset-grid">
                        {assets.background.map((a) => (
                          <button
                            key={a.id}
                            className={`ap-asset ${roomBg === a.url ? 'active' : ''}`}
                            onClick={() => setRoomBg(a.url)}
                          >
                            <img src={resolveMediaUrl(a.url)} alt={a.name} />
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === 'bubble' && (
              <div className="ap-body">
                <label className="modal-label">气泡主题</label>
                <div className="ap-swatches">
                  {BUBBLE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={`ap-swatch none wide ${JSON.stringify(bubble) === JSON.stringify(p.value) ? 'active' : ''}`}
                      onClick={() => setBubble(p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {bubble && (
                  <>
                    <label className="modal-label">我的气泡</label>
                    <ColorRow label="背景色" value={bubble.self?.bg || null}
                      onChange={(v) => setBubbleSide('self', 'bg', v)} />
                    <ColorRow label="文字色" value={bubble.self?.color || null}
                      onChange={(v) => setBubbleSide('self', 'color', v)} />
                    <ColorRow label="边框色" value={bubble.self?.border || null}
                      onChange={(v) => setBubbleSide('self', 'border', v)} />

                    <label className="modal-label">对方气泡</label>
                    <ColorRow label="背景色" value={bubble.other?.bg || null}
                      onChange={(v) => setBubbleSide('other', 'bg', v)} />
                    <ColorRow label="文字色" value={bubble.other?.color || null}
                      onChange={(v) => setBubbleSide('other', 'color', v)} />
                    <ColorRow label="边框色" value={bubble.other?.border || null}
                      onChange={(v) => setBubbleSide('other', 'border', v)} />
                  </>
                )}

                <label className="modal-label">
                  圆角 {bubble?.self?.radius ?? bubble?.other?.radius ?? 12}px
                </label>
                <input
                  type="range"
                  min="0"
                  max="40"
                  value={bubble?.self?.radius ?? bubble?.other?.radius ?? 12}
                  className="ap-range"
                  onChange={(e) => {
                    const r = Number(e.target.value);
                    setBubble((b) => ({
                      ...(b || {}),
                      self: { ...(b?.self || {}), radius: r },
                      other: { ...(b?.other || {}), radius: r }
                    }));
                  }}
                />

                {assets.bubble.length > 0 && (
                  <>
                    <label className="modal-label">我的气泡素材（含商城购买的）</label>
                    <div className="ap-asset-grid">
                      {assets.bubble.map((a) => (
                        <button
                          key={a.id}
                          className="ap-asset"
                          title={a.name}
                          onClick={() => {
                            // 购买的「气泡主题」自带配置，直接整套套用
                            if (a.meta && (a.meta.self || a.meta.other)) setBubble(a.meta);
                            else setBubbleSide('self', 'image', a.url);
                          }}
                        >
                          <img src={resolveMediaUrl(a.url)} alt={a.name} />
                        </button>
                      ))}
                    </div>
                  </>
                )}

                <label className="modal-label">
                  聊天字号 {fontSize ?? '默认'} {fontSize ? 'px' : ''}
                </label>
                <input
                  type="range"
                  min={limits.fontMin || 12}
                  max={limits.fontMax || 20}
                  value={fontSize ?? 14}
                  className="ap-range"
                  onChange={(e) => setFontSize(Number(e.target.value))}
                />
                <div className="ap-row">
                  <button className="btn-secondary"
                    style={{ flex: 'none', padding: '6px 14px', fontSize: 13 }}
                    onClick={() => setFontSize(null)}>
                    恢复默认字号
                  </button>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose}>取消</button>
              <button className="auth-submit" disabled={saving} onClick={save}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}