// client/src/components/common/ImageLightbox.jsx
//
// 图片灯箱。
//
// 【本次改动】增加 `protected` 属性：
//   受保护内容（表情）打开灯箱时：
//     · 隐藏工具栏里的"下载"按钮
//     · 图片上拦截右键与拖拽（防止"图片另存为"/拖到桌面）
//   普通聊天图片不传这个属性，行为与之前完全一致。
//
// 注意：这不是安全边界 —— 开发者工具 / 截图 / 直接从 URL 拉，都拦不住。
//   这里只是「堵住最明显的出口」。真正的护城河是服务端不提供文件下载通道。
//
import { useEffect, useState } from 'react';

export default function ImageLightbox({ src, alt, protected: isProtected, onClose }) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(z + 0.25, 4));
      if (e.key === '-') setZoom((z) => Math.max(z - 0.25, 0.25));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const block = (e) => e.preventDefault();

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="关闭">
        ×
      </button>

      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}>−</button>
        <span className="lightbox-zoom">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}>+</button>
        <button onClick={() => setZoom(1)}>重置</button>
        {/* [NEW] 受保护内容（表情）不提供"下载"入口 */}
        {!isProtected && (
          <a
            className="lightbox-download"
            href={src}
            download={alt || 'image'}
            onClick={(e) => e.stopPropagation()}
          >
            下载
          </a>
        )}
      </div>

      <img
        className="lightbox-img"
        src={src}
        alt={alt || ''}
        style={{ transform: `scale(${zoom})` }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        // [NEW] 受保护内容拦右键 / 拖拽
        onContextMenu={isProtected ? block : undefined}
        onDragStart={isProtected ? block : undefined}
      />
    </div>
  );
}