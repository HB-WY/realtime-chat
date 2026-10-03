import { useState, useEffect } from 'react';
import Avatar from '../common/Avatar';

export default function JoinGroupModal({ socket, onClose }) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [msg, setMsg] = useState('');
  const [appliedIds, setAppliedIds] = useState(new Set());

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const search = () => {
    const q = keyword.trim();
    if (!q || !socket) return;
    socket.emit('groups:search', { keyword: q }, (res) => {
      if (res?.ok) setResults(res.groups || []);
    });
  };

  const apply = (g) => {
    if (!socket) {
      setMsg('连接已断开，请稍后重试');
      return;
    }
    socket.emit('group:request', { groupId: g.id }, (ack) => {
      if (ack?.ok) {
        setAppliedIds((s) => new Set([...s, g.id]));
        setMsg(`已向「${g.name}」提交加群申请`);
      } else {
        setMsg(ack?.error || '申请失败');
      }
      setTimeout(() => setMsg(''), 2500);
    });
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">发现群聊</span>
          <button className="icon-btn" onClick={onClose}>
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>

        <div className="search-row">
          <input
            className="auth-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
            placeholder="输入群名搜索"
          />
          <button
            className="auth-submit"
            style={{ width: 100, marginTop: 0 }}
            onClick={search}
          >
            搜索
          </button>
        </div>

        {msg && <div className="modal-msg">{msg}</div>}

        <div className="user-result-list">
          {results.length === 0 && <div className="modal-empty">暂无结果</div>}
          {results.map((g) => (
            <div key={g.id} className="user-result-item">
              <Avatar name={g.name} avatar={g.avatar} size={32} />
              <div className="user-result-info">
                <div className="user-result-name">{g.name}</div>
                <div className="user-result-sub">{g.member_count} 人</div>
              </div>
              <button
                className="btn-secondary"
                style={{ flex: 'none', padding: '6px 16px', fontSize: 13 }}
                disabled={appliedIds.has(g.id)}
                onClick={() => apply(g)}
              >
                {appliedIds.has(g.id) ? '已申请' : '申请加入'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}