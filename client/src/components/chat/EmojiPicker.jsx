import { useEffect, useRef } from 'react';
import { EMOJIS } from '../../constants/emojis';

export default function EmojiPicker({ onPick, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      // 忽略触发开关的那个按钮，否则会出现“关不掉”的鬼畜
      if (e.target.closest && e.target.closest('.emoji-btn')) return;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="emoji-picker">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          className="emoji-item"
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}