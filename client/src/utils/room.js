/** 私聊房间 ID：房间号小的在前，保证双方生成同一 ID */
export function privateRoomId(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `p_${x}_${y}`;
}

/**
 * 会话列表 / 下拉菜单里显示的消息摘要。
 *
 * [FIX] 附件消息按 fileType 显示占位文案 —— **四种类型都要覆盖**（DEVLOG §1.60）：
 *   image / video / audio / file
 * 漏掉 video / audio 会让「只发了视频、没配文字」的消息在会话列表和导航浮层
 * 里显示为空字符串。
 */
export function roomPreview(room, currentUserId, limit = 20) {
  const m = room?.lastMessage;
  // 【新增】好友常驻会话没聊过天时，把个性签名当摘要展示（微信风格）
  if (!m) return room?.signature || '暂无消息';
  const who =
    m.senderId === currentUserId ? '我: ' : room.type !== 'private' ? `${m.senderName}: ` : '';
  const body =
    m.fileType === 'image' ? '[图片]'
    : m.fileType === 'video' ? '[视频]'
    : m.fileType === 'audio' ? '[音频]'
    : m.fileType === 'file'  ? '[文件]'
    : (m.text || '').slice(0, limit);
  return `${who}${body}`;
}