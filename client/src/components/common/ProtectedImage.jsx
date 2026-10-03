// client/src/components/common/ProtectedImage.jsx
//
// 「防随手另存」的图片：商城**试看 / 预览**里的图片一律用它渲染。
//
// 它挡掉的是**顺手右键另存**这条路（占真实使用的绝大多数）：
//   · 右键菜单：容器与 `<img>` 上都 `preventDefault`（手机长按触发的也是这个事件）
//   · 拖到桌面 / 拖进别的窗口：`draggable={false}` + 盖一层透明盾
//   · 选中后复制：`user-select:none` / `-webkit-user-drag:none` / `-webkit-touch-callout:none`
//
// [SEC] 这不是「防盗」，只是**提高顺手拿走的成本**。图片一旦进了浏览器就一定能被取走：
//   开发者工具、网络面板、浏览器缓存、内存里的 objectURL、截图…… 一个都拦不住。
//   真正的护城河在服务端 —— **预览给的应该是降采样 / 带水印的派生图，而不是交付物原件**
//   （见 ERRORLOG §17.4 的取舍与建议）。所以别把这个组件当安全边界用。
//
import { useCallback } from 'react';

export default function ProtectedImage({
  src,
  alt,
  className = '',
  imgClassName = '',
  onClick,
  title,
  loading,
  decoding,
  shield = true
}) {
  const block = useCallback((e) => {
    e.preventDefault();
  }, []);

  return (
    <span
      className={`prot-img ${className}`.trim()}
      onContextMenu={block}
      onDragStart={block}
      onClick={onClick}
      title={title}
    >
      <img
        src={src}
        alt={alt}
        className={imgClassName}
        draggable={false}
        loading={loading}
        decoding={decoding}
        onContextMenu={block}
        onDragStart={block}
      />
      {/* 透明盾：右键与拖拽都落在它身上（图片本身 pointer-events:none），
          事件冒泡到容器后被统一拦掉 */}
      {shield && <span className="prot-img-shield" aria-hidden="true" />}
    </span>
  );
}
