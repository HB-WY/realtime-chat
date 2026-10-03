import { useEffect, useRef } from 'react';

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  if (!items || items.length === 0) return null;

  const width = 140;
  const height = items.length * 34 + 8;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);

  return (
    <div ref={ref} className="context-menu" style={{ left, top }}>
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="context-divider" />
        ) : (
          <button
            key={i}
            className={`context-item ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}