import { Virtuoso } from 'react-virtuoso';
import MessageBubble from './MessageBubble';

export default function MessageList({
  messages,
  virtuosoRef,
  searchQuery,
  currentUserId,
  // 【本次新增】socket 透传给 MessageBubble → 支付卡片（转账/红包）
  //   订阅 transfer:accepted / redpacket:grabbed 等实时事件
  socket,
  onRead,
  onOpenMenu,
  onImageClick,
  onAtBottom,
  // 【新增】点击头像 → 用户卡片
  onAvatarClick
}) {
  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <svg
            viewBox="0 0 64 64"
            width="56"
            height="56"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 16h40a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H30l-10 8v-8h-8a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z" />
          </svg>
        </div>
        <div className="empty-title">
          {searchQuery ? '没有匹配的消息' : '暂无消息'}
        </div>
        <div className="empty-desc">
          {searchQuery ? '换个关键词试试' : '发送第一条消息，开启对话'}
        </div>
      </div>
    );
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={messages}
      // [FIX] followOutput 原来是 `'smooth'`（无条件）：只要 Virtuoso 认为
      //   "在底部"，任何高度重算（图片加载、状态行出现、字体变化）都会触发
      //   一次平滑滚动，与用户的手动滚动形成「滚 → 被打断 → 再滚」的拉锯，
      //   表现为到底部附近的诡异抖动。
      //   现在改成函数：只在**确实在底部**时才跟随，且用 `'auto'`（瞬时贴底）
      //   而不是 `'smooth'` —— 后者是动画滚动，天生容易被新指令打断。
      followOutput={searchQuery ? false : (isAtBottom) => (isAtBottom ? 'auto' : false)}
      atBottomStateChange={onAtBottom}
      // [FIX] 120px 太大：用户滚到距底 120px 时就被判定"在底部"，此时最后
      //   一条气泡其实还在视口外。降到 40（Virtuoso 常见推荐值），让"到底"
      //   的判定贴近视觉真实。
      atBottomThreshold={40}
      // [FIX] 视口外各多渲染 400px：给 ResizeObserver 一个缓冲，减少测量抖动。
      increaseViewportBy={{ top: 400, bottom: 400 }}
      // [FIX] 用 id 作为 item 的稳定 key（而非默认的 index）：消息顺序变化
      //   （撤回过滤、搜索命中）时不会串位，也避免 Virtuoso 误判某条 item
      //   是"新 item"而重新测量。
      computeItemKey={(index, msg) => msg.id || `sys-${index}-${msg.createdAt}`}
      initialTopMostItemIndex={Math.max(0, messages.length - 1)}
      itemContent={(index, msg) => (
        <MessageBubble
          key={msg.id || `sys-${index}-${msg.createdAt}`}
          message={msg}
          prevMessage={messages[index - 1]}
          isSelf={msg.senderId === currentUserId}
          currentUserId={currentUserId}
          // 【本次新增】支付卡片需要 socket 订阅实时事件
          socket={socket}
          onRead={onRead}
          onOpenMenu={onOpenMenu}
          onImageClick={onImageClick}
          onAvatarClick={onAvatarClick}
        />
      )}
    />
  );
}