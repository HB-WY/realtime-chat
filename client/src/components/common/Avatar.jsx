import { memo } from 'react';
import { resolveMediaUrl, isImageRef } from '../../utils/media';

const PALETTE = [
  '#222222', '#5A6472', '#8B6E4E', '#7B6AA8',
  '#4E8FA8', '#6A9E6A', '#A86A85', '#4E6AA8'
];

function pickColor(seed) {
  const s = seed || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function Avatar({ name, avatar, self, hidden, size = 38 }) {
  const base = {
    width: size,
    height: size,
    // 统一「方形圆角」（不是圆形）：圆角随尺寸等比缩放，
    // 与导航栏品牌图标、emoji 选择格保持同一套视觉。
    borderRadius: Math.round(size * 0.3),
    fontSize: Math.round(size * 0.55)
  };

  // 根节点用 span：这样头像可以合法地放进 <button>（如导航项、列表行）
  if (hidden) {
    return <span className="avatar avatar-hidden" style={base} />;
  }

  const raw = (avatar || '').trim();

  // 1) 上传的图片
  if (raw && isImageRef(raw)) {
    return (
      <span
        className={`avatar avatar-image ${self ? 'self' : ''}`}
        style={base}
        title={name}
      >
        <img src={resolveMediaUrl(raw)} alt={name || ''} loading="lazy" />
      </span>
    );
  }

  // 2) 单个 emoji / 字符
  if (raw) {
    const ch = Array.from(raw)[0] || '';
    return (
      <span
        className={`avatar avatar-emoji ${self ? 'self' : ''}`}
        style={base}
        title={name}
      >
        {ch}
      </span>
    );
  }

  // 3) 昵称首字
  const letter = (name || '?').slice(0, 1).toUpperCase();
  return (
    <span className={`avatar ${self ? 'self' : ''}`} style={{ ...base, background: pickColor(name) }} title={name}>
      {letter}
    </span>
  );
}

export default memo(Avatar);