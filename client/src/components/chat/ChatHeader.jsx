import Avatar from '../common/Avatar';

export default function ChatHeader({
  room, searchOpen, onToggleSearch, onOpenGroupInfo,
  canManagePublicRoom, onOpenPublicRoomIcon,
  // 【新增】私聊头部：点头像/昵称弹用户卡片
  onOpenUserCard
}) {
  if (!room) return null;

  // 【新增】私聊头部展示对端签名（好友常驻会话由 rooms 带过来）
  const showSignature = room.type === 'private' && !!room.signature;
  const openCard = room.type === 'private' && room.peerId != null && onOpenUserCard
    ? () => onOpenUserCard(room.peerId)
    : null;

  return (
    <div className="chat-header">
      <div className="chat-title">
        {openCard ? (
          <span className="avatar-click" title="查看资料" onClick={openCard}>
            <Avatar name={room.name} avatar={room.avatar} size={34} />
          </span>
        ) : (
          <Avatar name={room.name} avatar={room.avatar} size={34} />
        )}

        {room.type === 'public' && (
          <>
            公共聊天 <span className="chat-type">(群聊)</span>
          </>
        )}
        {room.type === 'private' && (
          <span className="chat-title-text" onClick={openCard || undefined}
                style={openCard ? { cursor: 'pointer' } : undefined}
                title={openCard ? '查看资料' : undefined}>
            {room.name} <span className="chat-type">(私聊)</span>
            {showSignature && <span className="chat-title-signature">{room.signature}</span>}
          </span>
        )}
        {room.type === 'group' && (
          <span onClick={onOpenGroupInfo} style={{ cursor: 'pointer' }}>
            {room.name} <span className="chat-type">(群聊 · 点击查看)</span>
          </span>
        )}
      </div>

      <div className="chat-actions">
        <button onClick={onToggleSearch}>
          {searchOpen ? '关闭搜索' : '搜索'}
        </button>
        {room.type === 'group' && (
          <button onClick={onOpenGroupInfo}>群信息</button>
        )}
        {room.type === 'public' && canManagePublicRoom && (
          <button onClick={onOpenPublicRoomIcon}>更换图标</button>
        )}
      </div>
    </div>
  );
}
