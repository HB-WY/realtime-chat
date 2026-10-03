// 纯文字按钮，不带数字、不带边框，点击打开积分流水。
export default function PointsBadge({ onClick }) {
  return (
    <button className="action-btn" onClick={onClick} title="查看积分流水">
      积分
    </button>
  );
}