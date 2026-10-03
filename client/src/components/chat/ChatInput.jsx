// client/src/components/chat/ChatInput.jsx
//
// 【本次改动】发送表情时带 stickerPackId：
//   让这条消息能被反查到"属于哪个表情包"，聊天界面右键时据此决定
//   显示「购买」还是「查看表情包」。
//
// 【本次改动】加 "+" 菜单：
//   在输入区的工具条上新增一个 "+" 按钮，点开菜单可发起「转账」「红包」。
//   转账只在私聊里可用（群转账 UI 语义太复杂，先不做）；红包群聊 / 私聊都行。
//   实际弹窗由父组件（ChatRoom）渲染，这里只负责触发回调。
//
// [CHANGED] 认证改造：不再接收 token prop。uploadFile 由 http.js 从
//   auth/session.js 的内存里读 Access Token。
//
import { useRef, useState, useEffect } from 'react';
import { uploadFile } from '../../api';
import { resolveMediaUrl } from '../../utils/media';
import FileTypeIcon from '../common/FileTypeIcon';
import Icon from '../common/Icon';
import EmojiPicker from './EmojiPicker';
import StickerPicker from '../stickers/StickerPicker';

export default function ChatInput({
  onSend,
  onTyping,
  disabled,
  onlineUsers = [],
  selfId,
  draft = '',
  onDraftChange,
  onOpenStickerManager,
  stickerRevision = 0,
  // 【新增】"+" 菜单触发的回调；不传则该菜单不显示
  roomType,
  onOpenTransfer,
  onOpenRedPacket
}) {
  const [text, setText] = useState(draft || '');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  // 【新增】"+" 菜单展开状态
  const [showPayMenu, setShowPayMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const ref = useRef(null);
  const fileRef = useRef(null);
  const payMenuRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  useEffect(() => {
    onDraftChange?.(text);
  }, [text, onDraftChange]);

  // 【新增】"+" 菜单：点外部 / Esc 关闭
  useEffect(() => {
    if (!showPayMenu) return undefined;
    const onDown = (e) => {
      if (payMenuRef.current && !payMenuRef.current.contains(e.target)) {
        setShowPayMenu(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setShowPayMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showPayMenu]);

  const mentionCandidates =
    mentionQuery === null
      ? []
      : onlineUsers
          .filter(
            (u) =>
              u.id !== selfId &&
              u.nickname.toLowerCase().includes(mentionQuery.toLowerCase())
          )
          .slice(0, 6);

  const clearAll = () => {
    setText('');
    setMentionQuery(null);
    setPendingFile(null);
    ref.current?.focus();
  };

  const send = () => {
    const t = text.trim();
    if (!t && !pendingFile) return;
    if (disabled || uploading) return;

    onSend({
      text: t,
      fileUrl: pendingFile?.url || null,
      fileName: pendingFile?.name || null,
      fileType: pendingFile?.kind || null,
      fileSize: pendingFile?.size ?? null
    });

    setText('');
    setMentionQuery(null);
    setPendingFile(null);
    onTyping(false);
  };

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    onTyping(v.length > 0);
    const cursor = e.target.selectionStart ?? v.length;
    const before = v.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else setMentionQuery(null);
  };

  const applyMention = (u) => {
    const el = ref.current;
    const cursor = el?.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) return;
    const atStart = cursor - match[0].length;
    const next =
      text.slice(0, atStart) + '@' + u.nickname + ' ' + text.slice(cursor);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = atStart + u.nickname.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  };

  const handleKey = (e) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mentionCandidates[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const pickFile = () => fileRef.current?.click();

  const uploadAndSet = async (file) => {
    setUploading(true);
    try {
      const res = await uploadFile(file);
      setPendingFile({
        url: res.url,
        name: res.name,
        kind: res.kind,
        mime: res.mime,
        size: res.size,
        playback: res.playback || null
      });
    } catch (err) {
      alert(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    await uploadAndSet(f);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        uploadAndSet(file);
        return;
      }
    }
  };

  const canOpenTransfer = typeof onOpenTransfer === 'function' && roomType === 'private';
  const canOpenRedPacket = typeof onOpenRedPacket === 'function'
    && (roomType === 'group' || roomType === 'private');
  const showPlus = canOpenTransfer || canOpenRedPacket;

  return (
    <div className={`input-area ${disabled ? 'disabled' : ''}`}>
      <div className="input-toolbar">
        {/* 【新增】"+" 菜单：转账 / 红包 */}
        {showPlus && (
          <div style={{ position: 'relative' }} ref={payMenuRef}>
            <button
              type="button"
              className="pay-plus-btn"
              onClick={() => setShowPayMenu((v) => !v)}
              disabled={disabled}
              title="更多"
            >
              <Icon name="plus" size={16} />
            </button>
            {showPayMenu && (
              <div className="pay-menu">
                {canOpenTransfer && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowPayMenu(false);
                      onOpenTransfer();
                    }}
                  >
                    <Icon name="receipt" size={16} className="pay-menu-icon" />
                    转账
                  </button>
                )}
                {canOpenRedPacket && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowPayMenu(false);
                      onOpenRedPacket();
                    }}
                  >
                    <Icon name="package" size={16} className="pay-menu-icon" />
                    红包
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="emoji-btn"
          onClick={() => {
            setShowEmoji((v) => !v);
            setShowStickers(false);
          }}
          disabled={disabled}
        >
          表情
        </button>
        <button
          type="button"
          className="sticker-btn"
          onClick={() => {
            setShowStickers((v) => !v);
            setShowEmoji(false);
          }}
          disabled={disabled}
        >
          表情包
        </button>
        <button type="button" onClick={pickFile} disabled={disabled || uploading}>
          {uploading ? '上传中...' : '文件'}
        </button>
        <button type="button" onClick={clearAll} disabled={disabled}>
          清空
        </button>
        <input ref={fileRef} type="file" hidden onChange={onFileChange} />
      </div>

      {pendingFile && (
        <div className="pending-attachment">
          {pendingFile.kind === 'image' ? (
            <img
              src={resolveMediaUrl(pendingFile.url)}
              alt={pendingFile.name}
              className="pending-thumb"
            />
          ) : (
            <span className="pending-file-icon" aria-hidden="true">
              <FileTypeIcon name={pendingFile.name} mime={pendingFile.mime} size={30} />
            </span>
          )}
          <div className="pending-file-info">
            <div className="pending-file-name">{pendingFile.name}</div>
            <div className="pending-file-sub">
              {{ image: '图片', video: '视频', audio: '音频' }[pendingFile.kind] || '文件'}
              {pendingFile.playback?.needed ? ' · 服务器会转成可在线播放的格式' : ''}
            </div>
          </div>
          <button
            className="pending-remove"
            onClick={() => setPendingFile(null)}
            title="移除"
          >
            ×
          </button>
        </div>
      )}

      <div className="input-wrapper">
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div className="mention-list">
            {mentionCandidates.map((u, i) => (
              <button
                key={u.id}
                type="button"
                className={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMention(u);
                }}
              >
                @{u.nickname}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          placeholder={
            disabled
              ? '连接中...'
              : '按 Enter 发送，Shift + Enter 换行（可直接粘贴图片）'
          }
          disabled={disabled}
          rows={1}
          className="input-textarea"
        />

        <button
          className="send-btn"
          onClick={send}
          disabled={disabled || uploading || (!text.trim() && !pendingFile)}
        >
          发送
        </button>
      </div>

      {showEmoji && (
        <EmojiPicker
          onPick={(e) => {
            const el = ref.current;
            const pos = el?.selectionStart ?? text.length;
            const next = text.slice(0, pos) + e + text.slice(pos);
            setText(next);
            onTyping(true);
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(pos + e.length, pos + e.length);
            });
          }}
          onClose={() => setShowEmoji(false)}
        />
      )}

      {showStickers && (
        <StickerPicker
          revision={stickerRevision}
          onClose={() => setShowStickers(false)}
          onManage={onOpenStickerManager}
          onPick={(sticker) => {
            if (disabled || uploading) return;
            // 带上 stickerPackId：聊天界面右键时据此判断"是否显示购买入口"
            //   后端允许 packId 为空（历史遗留），但带了必须真实存在
            onSend({
              text: '',
              fileUrl: sticker.url,
              fileName: sticker.name,
              fileType: 'image',
              fileSize: null,
              isSticker: true,
              stickerPackId: sticker.packId || null
            });
            setShowStickers(false);
          }}
        />
      )}
    </div>
  );
}