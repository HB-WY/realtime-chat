import { useState, useEffect, useRef } from 'react';
import Avatar from '../common/Avatar';

export default function AddFriendModal({ socket, onClose }) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [sentIds, setSentIds] = useState(new Set());
  const [msg, setMsg] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const search = () => {
    const q = keyword.trim();
    if (!q || !socket) return;
    socket.emit('users:search', { keyword: q }, (res) => {
      if (res?.ok) setResults(res.users || []);
    });
  };

  const sendRequest = (u) => {
    if (!socket) return;
    socket.emit('friend:request', { username: u.username }, (ack) => {
      if (ack?.ok) {
        setSentIds((s) => new Set([...s, u.id]));
        setMsg(`已向 ${u.nickname} 发送好友申请`);
      } else {
        setMsg(ack?.error || '发送失败');
      }
      setTimeout(() => setMsg(''), 2500);
    });
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">添加好友</span>
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

        <div className="modal-label">按用户名或昵称搜索</div>
        <div className="search-row">
          <input
            ref={inputRef}
            className="auth-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
            placeholder="输入用户名或昵称"
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
          {results.map((u) => (
            <div key={u.id} className="user-result-item">
              <Avatar name={u.nickname} avatar={u.avatar} size={36} />
              <div className="user-result-info">
                <div className="user-result-name">{u.nickname}</div>
                <div className="user-result-sub">@{u.username}</div>
              </div>
              <button
                className="btn-secondary"
                style={{ flex: 'none', padding: '6px 16px', fontSize: 13 }}
                disabled={sentIds.has(u.id)}
                onClick={() => sendRequest(u)}
              >
                {sentIds.has(u.id) ? '已发送' : '加好友'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}