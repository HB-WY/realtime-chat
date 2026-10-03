// client/src/components/chat/MessageBubble.jsx
//
// 【本次改动】
//   · 表情消息改用 ProtectedImage 包裹：右键 / 拖拽 / 手机长按全拦
//   · 表情消息打开灯箱时带上 protected: true → 灯箱隐藏"下载"按钮
//   · memo 比较补上 stickerPackId 与 replyTo（原实现漏了，将来若支持
//     "编辑引用"会显示旧内容）
//   · 视频/音频也拦右键"另存为"（原生控制条不受影响）
//
// 【本次修复】C2：<FileTypeIcon> 不再传 `mime={message.mime}`。
//   后端 loadHistory 从未下发 mime 字段（给的是 fileType），恒为 undefined，
//   等于白传。删掉后行为完全一致（fileKind 本来就按扩展名判）。
//
// 【本次新增】支付消息：ref_type='transfer' / 'red_packet' 时渲染专用卡片。
//   · 卡片组件自己拉详情、订阅 socket 事件
//   · MessageBubble 只负责把它放到气泡区里
//   · memo 比较函数补上 refType / refId
//
// [CHANGED] 认证改造：不再接收 token prop。getMediaStatus 由 http.js 从
//   auth/session.js 的内存里读 Access Token。
//
import { memo, useEffect, useState } from 'react';
import { resolveMediaUrl, formatTranscodeProgress } from '../../utils/media';
import {
  PHASE_DIRECT, PHASE_WAITING, PHASE_PLAY, PHASE_FALLBACK,
  POLL_MS, POLL_MAX, isMediaMessage, initialMedia, nextMediaState
} from '../../utils/mediaPlayback';
import { getMediaStatus } from '../../api/mediaApi';
import { formatTime, formatDateLabel, isSameDay } from '../../utils/timeUtils';
import { formatSize } from '../../utils/fileUtils';
import Avatar from '../common/Avatar';
import FileTypeIcon from '../common/FileTypeIcon';
import ProtectedImage from '../common/ProtectedImage';
// 【新增】支付卡片
import TransferCard from '../payments/TransferCard';
import RedPacketCard from '../payments/RedPacketCard';

function renderContent(text) {
  if (!text) return null;
  const re = /(https?:\/\/[^\s<>"']+)|@([A-Za-z0-9_\u4e00-\u9fa5-]{1,20})/g;
  const parts = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      parts.push(
        <a
          key={i++}
          href={m[1]}
          target="_blank"
          rel="noreferrer noopener"
          className="msg-link"
        >
          {m[1]}
        </a>
      );
    } else if (m[2]) {
      parts.push(
        <span key={i++} className="msg-mention">
          @{m[2]}
        </span>
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const MessageBubble = memo(
  function MessageBubble({
    message,
    isSelf,
    prevMessage,
    currentUserId,
    onRead,
    onOpenMenu,
    onImageClick,
    // 【新增】点击头像 → 弹出用户卡片（ChatRoom 提供）
    onAvatarClick,
    // 【新增】socket 传给支付卡片，用于实时更新
    socket
  }) {
    const isSystem = message.type === 'system';
    const isPrivate = message.roomType === 'private';

    const [media, setMedia] = useState(() => initialMedia(message));
    const { phase, tried, retryNonce } = media;

    // 虚拟列表滚动时同一个组件实例可能被换去渲染另一条消息 —— 这时状态必须
    // 整个重来，否则会把上一条的「转码中 / 可播地址」带过来。
    const [mediaMessageId, setMediaMessageId] = useState(message.id);
    if (mediaMessageId !== message.id) {
      setMediaMessageId(message.id);
      setMedia(initialMedia(message));
    }

    // 需要转码时轮询：后端每答一次就更新进度，转好了自动切到可播地址
    useEffect(() => {
      if (phase !== PHASE_WAITING || !message.fileUrl) return undefined;

      let alive = true;
      let timer = null;
      let tries = 0;

      const ask = async () => {
        tries += 1;
        try {
          const info = await getMediaStatus(message.fileUrl);
          if (!alive) return;
          const next = nextMediaState({ phase: PHASE_WAITING, tried }, info);
          if (next.phase === PHASE_WAITING && tries >= POLL_MAX) {
            setMedia((p) => ({
              ...nextMediaState(p, info),
              stalled: true,
              note: '转码还在进行，可稍后重新查询'
            }));
            return;
          }
          setMedia((p) => nextMediaState(p, info));
          if (next.phase === PHASE_WAITING) timer = setTimeout(ask, POLL_MS);
        } catch (err) {
          if (!alive) return;
          if (err?.status === 404) {
            setMedia((p) => ({ ...p, phase: PHASE_FALLBACK, note: '附件不存在或已删除' }));
            return;
          }
          if (tries >= POLL_MAX) {
            setMedia((p) => ({ ...p, phase: PHASE_WAITING, stalled: true, note: '查询转码状态失败' }));
            return;
          }
          timer = setTimeout(ask, POLL_MS * 2);
        }
      };

      ask();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, [phase, tried, retryNonce, message.fileUrl]);

    // 【新增】支付消息不需要走"已读回执"（一对多场景本就不该有 per-message 已读）
    const isPayment = message.refType === 'transfer' || message.refType === 'red_packet';
    const shouldReportRead =
      isPrivate &&
      !isSystem &&
      !isSelf &&
      !isPayment &&
      Array.isArray(message.readBy) &&
      !message.readBy.includes(currentUserId);

    useEffect(() => {
      if (shouldReportRead) onRead(message.id);
    }, [shouldReportRead, message.id, onRead]);

    if (isSystem) {
      return (
        <div className="system-message">
          <span>{message.text}</span>
        </div>
      );
    }

    const showDate =
      !prevMessage || !isSameDay(prevMessage.createdAt, message.createdAt);
    const others = (message.readBy || []).filter(
      (id) => id !== message.senderId
    );
    const readStatus =
      isSelf && isPrivate && !isPayment
        ? (others.length > 0 ? '已读' : '未读')
        : null;

    const handleContextMenu = (e) => {
      e.preventDefault();
      onOpenMenu({ x: e.clientX, y: e.clientY, message, isSelf });
    };

    /** 播放器自己报错时的处理：先问后端能不能转，别急着退回卡片 */
    const handleMediaError = () => {
      setMedia((prev) => {
        if (prev.phase === PHASE_PLAY) {
          return { ...prev, phase: PHASE_FALLBACK, note: '转码后的副本仍无法播放' };
        }
        if (prev.phase === PHASE_DIRECT) {
          return { ...prev, phase: PHASE_WAITING, tried: true, note: '正在检查是否需要转码…' };
        }
        return prev;
      });
    };

    const hasImage =
      !message.isSticker && message.fileType === 'image' && !!message.fileUrl;
    const hasSticker = !!message.isSticker && !!message.fileUrl;
    const isMedia = isMediaMessage(message);
    const hasVideo = isMedia && message.fileType === 'video';
    const hasAudio = isMedia && message.fileType === 'audio';
    const showPlayer = isMedia && (phase === PHASE_DIRECT || phase === PHASE_PLAY);
    const showWaiting = isMedia && phase === PHASE_WAITING;
    const hasFile =
      !message.isSticker && !!message.fileUrl
      && (message.fileType === 'file' || (isMedia && phase === PHASE_FALLBACK));
    const hasText = !!message.text;

    // 【新增】支付消息在气泡区渲染专用卡片，不走图片/文件/文字分支
    const hasTransfer = message.refType === 'transfer' && message.refId != null;
    const hasRedPacket = message.refType === 'red_packet' && message.refId != null;

    const fileSizeText = hasFile ? formatSize(message.fileSize) : '';
    const mediaUrl = hasImage || hasSticker || isMedia
      ? resolveMediaUrl(message.fileUrl) : '';
    const playerSrc = phase === PHASE_PLAY ? resolveMediaUrl(media.playUrl) : mediaUrl;
    const progressText = formatTranscodeProgress(media.progress);
    const progressPct = progressText ? Math.round(Math.min(media.progress, 0.99) * 100) : null;

    return (
      <>
        {showDate && (
          <div className="date-separator">
            <span>{formatDateLabel(message.createdAt)}</span>
          </div>
        )}

        <div className={`message ${isSelf ? 'self' : ''}`}>
          <div className="message-header">
            {/* 【新增】点击头像弹用户卡片（系统消息没有 senderId 时不响应） */}
            <span
              className={`avatar-click ${onAvatarClick ? '' : 'no-op'}`}
              onClick={() => onAvatarClick?.(message.senderId, message)}
              title="查看资料"
            >
              <Avatar
                name={message.senderName}
                avatar={message.senderAvatar}
                self={isSelf}
                size={32}
              />
            </span>
            <span className="message-username">
              {isSelf ? '我' : message.senderName}
            </span>
            <span className="message-time">{formatTime(message.createdAt)}</span>
          </div>

          {message.replyTo && (
            <div className="message-reply-preview">
              <span className="reply-name">{message.replyTo.name}</span>
              <span className="reply-text">{message.replyTo.text}</span>
            </div>
          )}

          <div className="message-body" onContextMenu={handleContextMenu}>
            {/* 【新增】转账卡片：自己拉详情、订阅 socket 事件 */}
            {hasTransfer && (
              <TransferCard
                transferId={message.refId}
                isSelf={isSelf}
                currentUserId={currentUserId}
                socket={socket}
              />
            )}

            {/* 【新增】红包卡片 */}
            {hasRedPacket && (
              <RedPacketCard
                redPacketId={message.refId}
                isSelf={isSelf}
                currentUserId={currentUserId}
                socket={socket}
              />
            )}

            {/* [NEW] 表情消息用 ProtectedImage 包裹：
                · 右键 / 拖拽 / 手机长按「存储图像」全拦（含一层透明盾）
                · 点击进灯箱时带 protected: true → 灯箱不显示"下载"按钮
                别人发来的表情也一并拦 —— 想让用户"获得"表情走表情包通道，
                不靠右键另存。 */}
            {hasSticker && (
              <span
                className="msg-sticker-wrap"
                onClick={() =>
                  onImageClick?.({
                    src: mediaUrl,
                    alt: message.fileName,
                    // 标记为受保护内容：灯箱隐藏下载按钮 + 拦右键
                    protected: true
                  })
                }
              >
                <ProtectedImage
                  src={mediaUrl}
                  alt={message.fileName || '表情'}
                  imgClassName="msg-sticker"
                  loading="lazy"
                  decoding="async"
                />
              </span>
            )}

            {/* 普通图片：不传 protected，聊天图片仍可下载 */}
            {hasImage && (
              <img
                src={mediaUrl}
                alt={message.fileName || '图片'}
                className="msg-image"
                loading="lazy"
                decoding="async"
                onClick={() =>
                  onImageClick?.({ src: mediaUrl, alt: message.fileName })
                }
              />
            )}

            {/* 视频：内联播放。preload="metadata" 只取首帧与时长，
                不自动播放（群里 20 个视频同时加载会直接拖死页面）。
                右键「视频另存为」一并拦掉（原生控制条不受影响）。 */}
            {showPlayer && hasVideo && (
              <video
                className="msg-video"
                src={playerSrc}
                controls
                preload="metadata"
                playsInline
                onError={handleMediaError}
                onContextMenu={(e) => e.preventDefault()}
              />
            )}

            {/* 音频：图标 + 原生播放条，占位比视频小得多 */}
            {showPlayer && hasAudio && (
              <div
                className="msg-audio"
                onContextMenu={(e) => e.preventDefault()}
              >
                {/* [FIX C2] 删掉 `mime={message.mime}` —— 后端从不下发该字段 */}
                <FileTypeIcon name={message.fileName} size={34} />
                <audio
                  className="msg-audio-el"
                  src={playerSrc}
                  controls
                  preload="metadata"
                  onError={handleMediaError}
                />
              </div>
            )}

            {/* 转码占位：进度条 + 一句人话，转好自动换成播放器 */}
            {showWaiting && (
              <div className={`msg-transcoding ${hasAudio ? 'compact' : ''}`}>
                <div className="msg-transcoding-row">
                  <span className="msg-transcoding-spin" aria-hidden="true" />
                  <span className="msg-transcoding-text">
                    {hasVideo ? '视频' : '音频'}
                    {progressText ? `正在转码 ${progressText}` : '正在转码'}
                  </span>
                </div>
                <div
                  className={`msg-transcoding-bar ${progressPct === null ? 'indeterminate' : ''}`}
                  role="progressbar"
                  aria-label="转码进度"
                  aria-valuenow={progressPct ?? undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={progressPct === null ? undefined : { width: `${progressPct}%` }} />
                </div>
                <div className="msg-transcoding-note">
                  {media.note || '转码完成后会自动播放'}
                </div>
                {media.stalled && (
                  <button
                    type="button"
                    className="msg-transcoding-retry"
                    onClick={() =>
                      setMedia((p) => ({
                        ...p,
                        stalled: false,
                        note: '正在重新查询…',
                        retryNonce: (p.retryNonce || 0) + 1
                      }))
                    }
                  >
                    继续等待
                  </button>
                )}
              </div>
            )}

            {hasFile && (
              <a
                href={resolveMediaUrl(message.fileUrl)}
                target="_blank"
                rel="noreferrer noopener"
                download={message.fileName}
                className="msg-file"
              >
                <span className="msg-file-icon" aria-hidden="true">
                  {/* [FIX C2] 同理，不再传 mime={message.mime} */}
                  <FileTypeIcon name={message.fileName} size={38} />
                </span>
                <span className="msg-file-meta">
                  <span className="msg-file-name" title={message.fileName || '文件'}>
                    {message.fileName || '文件'}
                  </span>
                  <span className="msg-file-size">
                    {fileSizeText}
                    {isMedia && phase === PHASE_FALLBACK
                      ? ` · ${media.note || '浏览器无法直接播放，下载后用本地播放器打开'}`
                      : ''}
                  </span>
                </span>
              </a>
            )}

            {hasText && (
              <div className="message-content">
                {renderContent(message.text)}
              </div>
            )}
          </div>

          {isSelf && readStatus && (
            <div className="message-status">{readStatus}</div>
          )}
        </div>
      </>
    );
  },
  (prev, next) => {
    const a = prev.message;
    const b = next.message;
    if (a === b && prev.prevMessage === next.prevMessage) return true;
    return (
      a.id === b.id &&
      a.text === b.text &&
      a.senderName === b.senderName &&
      a.senderAvatar === b.senderAvatar &&
      a.fileSize === b.fileSize &&
      a.fileType === b.fileType &&
      a.fileUrl === b.fileUrl &&
      !!a.isSticker === !!b.isSticker &&
      // [FIX] 补上 stickerPackId 与 replyTo（原实现漏比较，
      //   将来若支持"编辑引用"或服务端补发同 id 消息会显示旧内容）
      (a.stickerPackId ?? null) === (b.stickerPackId ?? null) &&
      JSON.stringify(a.replyTo) === JSON.stringify(b.replyTo) &&
      (a.readBy?.length || 0) === (b.readBy?.length || 0) &&
      (prev.prevMessage?.id || null) === (next.prevMessage?.id || null) &&
      prev.isSelf === next.isSelf &&
      prev.currentUserId === next.currentUserId &&
      // 【新增】支付消息的 refType / refId 变化时也要重渲
      (a.refType ?? null) === (b.refType ?? null) &&
      (a.refId ?? null) === (b.refId ?? null) &&
      // 【新增】socket 变化（重连等）时，卡片需要重新订阅
      prev.socket === next.socket &&
      prev.onRead === next.onRead &&
      prev.onOpenMenu === next.onOpenMenu &&
      prev.onImageClick === next.onImageClick &&
      prev.onAvatarClick === next.onAvatarClick
    );
  }
);

export default MessageBubble;