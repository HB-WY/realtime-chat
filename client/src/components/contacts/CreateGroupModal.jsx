import { useState, useEffect } from 'react';
import Avatar from '../common/Avatar';

export default function CreateGroupModal({ socket, friends, onClose }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const create = () => {
    if (!name.trim()) {
      setErr('请输入群名');
      return;
    }
    if (!socket) {
      setErr('连接已断开，请稍后重试');
      return;
    }
    socket.emit(
      'group:create',
      { name: name.trim(), memberIds: Array.from(selected) },
      (ack) => {
        if (ack?.ok) onClose();
        else setErr(ack?.error || '创建失败');
      }
    );
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">创建群聊</span>
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

        <label className="modal-label">群名称</label>
        <input
          className="auth-input"
          value={name}
          maxLength={30}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入群名称"
        />

        <label className="modal-label">选择好友加入（可选）</label>
        <div className="friend-pick-list">
          {friends.length === 0 && <div className="modal-empty">还没有好友</div>}
          {friends.map((f) => (
            <label
              key={f.id}
              className={`friend-pick-item ${selected.has(f.id) ? 'active' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.has(f.id)}
                onChange={() => toggle(f.id)}
              />
              <Avatar name={f.nickname} avatar={f.avatar} size={32} />
              <div className="friend-pick-name">{f.nickname}</div>
            </label>
          ))}
        </div>

        {err && <div className="auth-error">{err}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="auth-submit" onClick={create}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}