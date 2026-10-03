export default function TypingIndicator({ names }) {
  if (!names || names.length === 0) return null;

  return (
    <div className="typing-indicator">
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
      {names.join('、')} 正在输入
    </div>
  );
}