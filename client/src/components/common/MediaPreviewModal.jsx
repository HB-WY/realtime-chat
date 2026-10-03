// client/src/components/common/MediaPreviewModal.jsx
//
// 通用「预览」浮层：图片 / 视频 / 音频 / PDF / 文本。
//
// 为什么父组件传的是 objectURL 而不是直链：本站受保护的文件（uploads/shop）
// **没有静态暴露**，必须先带鉴权取回 Blob 再转 URL —— 见 shopApi.previewFileBlob()。
// 所以这个组件只管渲染，不负责取数，取数由调用方决定（并负责 revoke）。
//
// 试看内容一律走 `ProtectedImage` / 拦掉右键菜单：这是**顺手另存**的主要入口
// （见 ProtectedImage 顶部说明 —— 它只是提高成本，不是安全边界）。
//
import { useCallback, useEffect } from 'react';
import ProtectedImage from './ProtectedImage';

const KIND_LABEL = {
  image: '图片', video: '视频', audio: '音频', pdf: 'PDF', text: '文本'
};

export default function MediaPreviewModal({
  title, kind, url, text, truncated, loading, note, error, onClose
}) {
  const blockMenu = useCallback((e) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pv-overlay" onMouseDown={onClose}>
      <div className="pv-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pv-head">
          <span className="pv-title" title={title}>{title}</span>
          <span className="pv-kind">{KIND_LABEL[kind] || '预览'}</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </div>

        <div className="pv-body">
          {loading && (
            <div className="pv-state">
              加载中…
              {/* 源格式浏览器播不了时，服务端会转码，这里显示进度 */}
              {note ? <div className="pv-note">{note}</div> : null}
            </div>
          )}
          {!loading && error && <div className="pv-state pv-error">{error}</div>}

          {!loading && !error && kind === 'image' && url && (
            <ProtectedImage
              src={url}
              alt={title}
              className="pv-imgwrap"
              imgClassName="pv-image"
            />
          )}
          {/* 视频 / 音频同样拦掉右键「视频另存为」；原生控制条不受影响 */}
          {!loading && !error && kind === 'video' && url && (
            <video
              className="pv-video"
              src={url}
              controls
              autoPlay
              playsInline
              onContextMenu={blockMenu}
              onDragStart={blockMenu}
            />
          )}
          {!loading && !error && kind === 'audio' && url && (
            <audio
              className="pv-audio"
              src={url}
              controls
              autoPlay
              onContextMenu={blockMenu}
            />
          )}
          {!loading && !error && kind === 'pdf' && url && (
            <iframe className="pv-frame" src={url} title={title} />
          )}
          {!loading && !error && kind === 'text' && (
            <div className="pv-textwrap">
              <pre className="pv-text">{text}</pre>
              {truncated && (
                <div className="pv-note">内容较长，只显示前 200 KB；完整内容请下载查看</div>
              )}
            </div>
          )}
          {!loading && !error && !['image', 'video', 'audio', 'pdf', 'text'].includes(kind) && (
            <div className="pv-state">
              该类型无法在线预览（浏览器不支持渲染），请下载后用本地程序打开
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
