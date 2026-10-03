import Avatar from '../common/Avatar';
import Icon from '../common/Icon';
import { roomPreview } from '../../utils/room';

const TITLE = { messages: '消息', contacts: '联系人', groups: '群聊' };

export default function ListPanel({
  tab, user, onlineUsers, rooms, activeKey, onOpenRoom,
  friends, receivedFriendReqs, onAcceptFriend, onRejectFriend, onOpenPrivateChat,
  groups, pendingGroupReqs, onApproveGroup, onRejectGroup, onOpenGroupChat,
  onOpenView, onOpenUserCard
}) {
  const count =
    tab === 'contacts' ? friends.length : tab === 'groups' ? groups.length : rooms.length;

  // 列表常驻显示（不再支持折叠）
  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>
          {TITLE[tab] || '消息'}
          <small>{count}</small>
        </h2>
      </div>

      {tab === 'messages' && (
        <RoomList
          rooms={rooms}
          activeKey={activeKey}
          meId={user.id}
          onlineUsers={onlineUsers}
          onOpen={onOpenRoom}
          onOpenUserCard={onOpenUserCard}
        />
      )}

      {tab === 'contacts' && (
        <ContactList
          friends={friends}
          requests={receivedFriendReqs}
          onlineUsers={onlineUsers}
          onAccept={onAcceptFriend}
          onReject={onRejectFriend}
          onOpen={onOpenPrivateChat}
          onAdd={() => onOpenView('addFriend')}
          onOpenUserCard={onOpenUserCard}
        />
      )}

      {tab === 'groups' && (
        <GroupList
          groups={groups}
          requests={pendingGroupReqs}
          onApprove={onApproveGroup}
          onReject={onRejectGroup}
          onOpen={onOpenGroupChat}
          onCreate={() => onOpenView('createGroup')}
          onJoin={() => onOpenView('joinGroup')}
        />
      )}
    </aside>
  );
}

function RoomList({ rooms, activeKey, meId, onlineUsers = [], onOpen, onOpenUserCard }) {
  return (
    <div className="chat-list">
      {rooms.map((r) => {
        // 【新增】好友会话：显示在线状态点（不管在不在线，会话都常驻）
        const isFriendOnline =
          r.type === 'private' &&
          r.peerId != null &&
          onlineUsers.some((u) => u.id === r.peerId);
        return (
          <div
            key={r.key}
            className={`chat-item ${activeKey === r.key ? 'active' : ''}`}
            onClick={() => onOpen(r)}
          >
            <div className="chat-icon">
              {/* 公共聊天 / 群聊都支持自定义图标（图片或 emoji）。
                  【新增】私聊会话的头像可点击 → 弹用户卡片 */}
              {r.type === 'private' && r.peerId != null && onOpenUserCard ? (
                <span
                  className="avatar-click"
                  title="查看资料"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenUserCard(r.peerId);
                  }}
                >
                  <Avatar name={r.name} avatar={r.avatar} size={36} />
                </span>
              ) : (
                <Avatar name={r.name} avatar={r.avatar} size={36} />
              )}
            </div>
            <div className="chat-info">
              <div className="chat-name">{r.name}</div>
              <div className="chat-preview">{roomPreview(r, meId)}</div>
            </div>
            {r.unread > 0 && (
              <span className="chat-badge">{r.unread > 99 ? '99+' : r.unread}</span>
            )}
            {r.type === 'private' && r.peerId != null && (
              <span className={`dot ${isFriendOnline ? 'online' : 'friend-offline'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ContactList({ friends, requests, onlineUsers, onAccept, onReject, onOpen, onAdd, onOpenUserCard }) {
  return (
    <div className="chat-list">
      <div className="list-actions">
        <button className="action-btn" onClick={onAdd}>
          <Icon name="plus" size={16} /> 添加好友
        </button>
      </div>

      {requests.length > 0 && (
        <div className="list-section">
          <div className="list-section-title">好友申请 ({requests.length})</div>
          {requests.map((r) => (
            <div key={r.id} className="request-item">
              <Avatar name={r.nickname} avatar={r.avatar} size={32} />
              <div className="request-info">
                <div className="request-name">{r.nickname}</div>
                <div className="request-sub">@{r.username}</div>
              </div>
              <div className="request-actions">
                <button className="mini-btn ok" onClick={() => onAccept(r.id)}>接受</button>
                <button className="mini-btn" onClick={() => onReject(r.id)}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="list-section">
        <div className="list-section-title">好友 ({friends.length})</div>
        {friends.length === 0 && <div className="modal-empty" style={{ padding: 20 }}>还没有好友</div>}
        {friends.map((f) => {
          const isOnline = onlineUsers.some((u) => u.id === f.id);
          return (
            <div key={f.id} className="chat-item" onClick={() => onOpen(f)}>
              <div className="chat-icon">
                {/* 【新增】头像可点击 → 弹用户卡片 */}
                {onOpenUserCard ? (
                  <span
                    className="avatar-click"
                    title="查看资料"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenUserCard(f.id);
                    }}
                  >
                    <Avatar name={f.nickname} avatar={f.avatar} size={36} />
                  </span>
                ) : (
                  <Avatar name={f.nickname} avatar={f.avatar} size={36} />
                )}
              </div>
              <div className="chat-info">
                <div className="chat-name">{f.nickname}</div>
                {/* 【新增】优先展示个性签名，没有签名再显示在线/离线 */}
                <div className="chat-preview">
                  {f.signature ? f.signature : (isOnline ? '在线' : '离线')}
                </div>
              </div>
              {isOnline && <span className="dot online" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupList({ groups, requests, onApprove, onReject, onOpen, onCreate, onJoin }) {
  return (
    <div className="chat-list">
      <div className="list-actions">
        <button className="action-btn" onClick={onCreate}>
          <Icon name="plus" size={16} /> 创建群
        </button>
        <button className="action-btn" onClick={onJoin}>
          <Icon name="search" size={16} /> 发现群
        </button>
      </div>

      {requests.length > 0 && (
        <div className="list-section">
          <div className="list-section-title">加群申请 ({requests.length})</div>
          {requests.map((r) => (
            <div key={r.id} className="request-item">
              <Avatar name={r.nickname} avatar={r.avatar} size={32} />
              <div className="request-info">
                <div className="request-name">{r.nickname}</div>
                <div className="request-sub">申请加入「{r.groupName}」</div>
              </div>
              <div className="request-actions">
                <button className="mini-btn ok" onClick={() => onApprove(r.id)}>同意</button>
                <button className="mini-btn" onClick={() => onReject(r.id)}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="list-section">
        <div className="list-section-title">我的群 ({groups.length})</div>
        {groups.length === 0 && (
          <div className="modal-empty" style={{ padding: 20 }}>还没有加入群聊</div>
        )}
        {groups.map((g) => (
          <div key={g.id} className="chat-item" onClick={() => onOpen(g)}>
            <div className="chat-icon">
              <Avatar name={g.name} avatar={g.avatar} size={36} />
            </div>
            <div className="chat-info">
              <div className="chat-name">{g.name}</div>
              <div className="chat-preview">{g.member_count} 人</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
