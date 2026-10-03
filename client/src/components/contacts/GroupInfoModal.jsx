import { useEffect, useState } from 'react';
import Avatar from '../common/Avatar';
import Icon from '../common/Icon';
import RoomIconEditor from '../common/RoomIconEditor';

// [FIX] 移除 token prop。
//   · 本组件自身从不使用 token；
//   · 传给 RoomIconEditor 也是多余的 —— 认证改造后 RoomIconEditor 早已
//     不再接收 token（它内部调 uploadAvatar 由 http.js 从 auth/session.js
//     的内存里读 Access）。
//   ChatRoom 的调用点也从来没传过 token，之前一直是死 prop。
export default function GroupInfoModal({ socket, groupId, me, friends, onClose }) {
  const [info, setInfo] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showIcon, setShowIcon] = useState(false);
  const [iconError, setIconError] = useState('');
  const [savingIcon, setSavingIcon] = useState(false);

  const load = () => {
    socket.emit('group:info', { groupId }, (res) => {
      if (res?.ok) setInfo(res.group);
    });
  };

  useEffect(() => {
    load();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, groupId, onClose]);

  // 群资料 / 成员变化由服务端广播 group:updated（踢人、设管理员、改图标都会发）。
  // 用事件驱动刷新，替代原来「emit 后 setTimeout 猜时间」的竞态做法。
  useEffect(() => {
    if (!socket) return undefined;
    const onUpdated = ({ groupId: gid } = {}) => {
      if (Number(gid) === Number(groupId)) load();
    };
    socket.on('group:updated', onUpdated);
    return () => socket.off('group:updated', onUpdated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, groupId]);

  const isOwner = info && (info.ownerId === me.id || info.myRole === 'owner');
  const isAdmin = info?.myRole === 'admin';
  // 群主 / 群管理员都可以换群图标；只有群主能改群名、任免管理员
  const canEditIcon = isOwner || isAdmin || !!info?.canEditIcon;

  const applyIcon = (next) => {
    setIconError('');
    setSavingIcon(true);
    socket.emit('group:update', { groupId, avatar: next }, (ack) => {
      setSavingIcon(false);
      if (ack?.ok) {
        setInfo(ack.group);
        setShowIcon(false);
      } else {
        setIconError(ack?.error || '设置失败');
      }
    });
  };

  const setMemberRole = (uid, role) => {
    socket.emit('group:member:role', { groupId, userId: uid, role }, (ack) => {
      if (ack?.ok) setInfo(ack.group);
      else alert(ack?.error || '设置失败');
    });
  };

  const invite = (uid) => {
    socket.emit('group:invite', { groupId, userId: uid }, (ack) => {
      if (ack?.ok) load();
      else alert(ack?.error || '邀请失败');
    });
  };

  const kick = (uid) => {
    if (!confirm('确定踢出该成员？')) return;
    // 服务端会广播 group:updated，上面的监听器负责刷新列表；
    // ack 只用来把失败原因告诉用户。
    socket.emit('group:kick', { groupId, userId: uid }, (ack) => {
      if (ack?.error) alert(ack.error);
    });
  };

  const leave = () => {
    if (
      !confirm(
        isOwner ? '你是群主，退群将解散该群，确定？' : '确定退出群聊？'
      )
    )
      return;
    socket.emit('group:leave', { groupId });
    onClose();
  };

  const memberIds = new Set((info?.members || []).map((m) => m.id));
  const inviteCandidates = friends.filter((f) => !memberIds.has(f.id));

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">群信息</span>
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

        {!info ? (
          <div className="modal-empty">加载中...</div>
        ) : (
          <>
            <div className="group-info-head">
              <Avatar name={info.name} avatar={info.avatar} size={64} />
              <div className="group-info-name">{info.name}</div>
              <div className="group-info-sub">
                {info.members.length} 名成员
                {isOwner && ' · 你是群主'}
                {!isOwner && isAdmin && ' · 你是群管理员'}
              </div>
              {canEditIcon && (
                <button
                  type="button"
                  className="btn-secondary group-icon-btn"
                  onClick={() => setShowIcon((v) => !v)}
                  disabled={savingIcon}
                >
                  <Icon name="image" size={16} />
                  {showIcon ? '收起图标设置' : info.avatar ? '更换群图标' : '设置群图标'}
                </button>
              )}
            </div>

            {showIcon && (
              <div className="invite-panel">
                {/* [FIX] 不再传 token —— RoomIconEditor 早已不接收该 prop。 */}
                <RoomIconEditor
                  name={info.name}
                  value={info.avatar}
                  onApply={applyIcon}
                  onError={setIconError}
                  disabled={savingIcon}
                  hint="群主 / 群管理员可设置 · emoji 或上传图片（手机相册 / 拍照均可，大图自动压缩）"
                />
                {iconError && <div className="auth-error">{iconError}</div>}
              </div>
            )}

            <div className="modal-label">群成员</div>
            <div className="member-list">
              {info.members.map((m) => (
                <div key={m.id} className="member-item">
                  <Avatar name={m.nickname} avatar={m.avatar} size={32} />
                  <div className="member-info">
                    <div className="member-name">
                      {m.nickname}
                      {m.role === 'owner' && (
                        <span className="role-tag">
                          <Icon name="crown" size={10} /> 群主
                        </span>
                      )}
                      {m.role === 'admin' && (
                        <span className="role-tag role-tag-admin">管理员</span>
                      )}
                    </div>
                    <div className="member-sub">@{m.username}</div>
                  </div>
                  {isOwner && m.id !== me.id && m.role !== 'owner' && (
                    <>
                      <button
                        className="mini-btn"
                        onClick={() =>
                          setMemberRole(m.id, m.role === 'admin' ? 'member' : 'admin')
                        }
                      >
                        {m.role === 'admin' ? '取消管理员' : '设为管理员'}
                      </button>
                      <button
                        className="btn-danger-mini"
                        onClick={() => kick(m.id)}
                      >
                        踢出
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                onClick={() => setShowInvite((v) => !v)}
              >
                {showInvite ? '收起邀请' : '邀请好友'}
              </button>
              <button
                className="btn-secondary"
                style={{ color: '#e74c3c', borderColor: '#f5b7b1' }}
                onClick={leave}
              >
                {isOwner ? '解散群聊' : '退出群聊'}
              </button>
            </div>

            {showInvite && (
              <div className="invite-panel">
                <div className="modal-label">选择好友加入</div>
                {inviteCandidates.length === 0 && (
                  <div className="modal-empty">没有可邀请的好友</div>
                )}
                {inviteCandidates.map((f) => (
                  <div key={f.id} className="member-item">
                    <Avatar name={f.nickname} avatar={f.avatar} size={32} />
                    <div className="member-info">
                      <div className="member-name">{f.nickname}</div>
                      <div className="member-sub">@{f.username}</div>
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ flex: 'none', padding: '5px 14px', fontSize: 12 }}
                      onClick={() => invite(f.id)}
                    >
                      邀请
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}