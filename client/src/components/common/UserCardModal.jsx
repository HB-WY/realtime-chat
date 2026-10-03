// client/src/components/common/UserCardModal.jsx
//
// 【新增】用户卡片：点击任何用户头像时弹出。
//   内容：大头像 + 昵称 + @用户名 + 个性签名 + 在线状态
//   动作：【私信】（复用 ChatRoom 的 openPrivateChat）
//         【加好友】（socket 'friend:request'，按 username 发起）
//   数据：优先用本地缓存（friends / message sender），再请求
//         GET /api/users/:id 拉最新公开资料（含 signature）。
//
import { useEffect, useState } from 'react';
import { getUserProfile } from '../../api';
import Avatar from './Avatar';

export default function UserCardModal({
  userId,
  me,
  socket,
  friends,
  onlineUsers = [],
  onClose,
  onPrivateChat
}) {
  // 本地已知信息先垫底（friends / 自己），避免网络抖动时白屏
  const local = userId === me.id
    ? { id: me.id, username: me.username, nickname: me.nickname, avatar: me.avatar, signature: me.signature || '' }
    : friends.find((f) => f.id === userId) || null;

  const [profile, setProfile] = useState(local);
  const [loading, setLoading] = useState(!local);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    getUserProfile(userId)
      .then((d) => {
        if (alive) setProfile(d.user);
      })
      .catch((err) => {
        // 拉取失败但本地有数据时照常显示；两者皆无才报错
        if (alive && !local) setError(err.message || '获取用户信息失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!profile && error) {
    return (
      <div className="modal-overlay" onMouseDown={onClose}>
        <div className="modal-card user-card" onMouseDown={(e) => e.stopPropagation()}>
          <div className="auth-error">{error}</div>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const isSelf = profile.id === me.id;
  const isFriend = !isSelf && friends.some((f) => f.id === profile.id);
  const isOnline = onlineUsers.some((u) => u.id === profile.id);

  const handleAddFriend = () => {
    if (!socket || sent) return;
    socket.emit('friend:request', { username: profile.username }, (ack) => {
      if (ack?.ok) {
        setSent(true);
      } else {
        setError(ack?.error || '发送失败');
        setTimeout(() => setError(''), 2500);
      }
    });
  };

  const handlePrivateChat = () => {
    onPrivateChat(profile);
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card user-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="user-card-banner">
          <Avatar name={profile.nickname} avatar={profile.avatar} size={72} />
          <div className="user-card-names">
            <div className="user-card-nickname">
              {profile.nickname}
              {!isSelf && (
                <span className={`user-card-presence ${isOnline ? 'online' : 'offline'}`}>
                  {isOnline ? '在线' : '离线'}
                </span>
              )}
            </div>
            {!isSelf && <div className="user-card-username">@{profile.username}</div>}
          </div>
        </div>

        <div className="user-card-signature">
          <span className="user-card-signature-label">个性签名</span>
          <span className="user-card-signature-text">
            {loading && !profile.signature ? '…' : (profile.signature || '这个人很懒，什么都没写')}
          </span>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="user-card-actions">
          {isSelf ? (
            <button className="btn-secondary" onClick={onClose}>
              这是我自己
            </button>
          ) : (
            <>
              <button
                className="btn-secondary user-card-btn"
                onClick={handleAddFriend}
                disabled={isFriend || sent}
              >
                {isFriend ? '已是好友' : sent ? '已发送申请' : '加好友'}
              </button>
              <button className="auth-submit user-card-btn" onClick={handlePrivateChat}>
                私信
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
