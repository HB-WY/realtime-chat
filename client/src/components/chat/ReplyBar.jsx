export default function ReplyBar({ replyTo, onCancel }) {
  if (!replyTo) return null;
  return (
    <div className="reply-bar">
      <div className="reply-bar-content">
        <span className="reply-bar-name">回复 {replyTo.senderName}</span>
        <span className="reply-bar-text">
          {(replyTo.text || replyTo.fileName || '').slice(0, 40)}
        </span>
      </div>
      <button className="text-btn" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}