import { useRef, useState } from 'react';
import { uploadAvatar } from '../../api';
import { AVATAR_PRESETS } from '../../constants/avatars';
import Avatar from '../common/Avatar';
import Icon from '../common/Icon';

/**
 * 房间图标编辑器（公共聊天 / 群聊共用）。
 *
 * 受控组件：点击 emoji 或上传图片后调用 onApply(next)，
 * 由父组件决定怎么持久化（socket group:update 或 REST /rooms/public/icon）。
 * onApply('') = 清除图标。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 *   · uploadAvatar 由 http.js 从 auth/session.js 内存里读 Access Token
 *   · 两个调用方（GroupInfoModal / PublicRoomIconModal）都同步去掉了 token
 */
export default function RoomIconEditor({
  name, value, onApply, onError, hint, disabled
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    onError?.('');
    try {
      const data = await uploadAvatar(file);
      await onApply(data.url);
    } catch (err) {
      onError?.(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const busy = !!disabled || uploading;

  return (
    <div className="room-icon-editor">
      <div className="room-icon-preview">
        <Avatar name={name} avatar={value} size={72} />
      </div>

      <div className="avatar-grid">
        {AVATAR_PRESETS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={`avatar-choice ${value === emoji ? 'active' : ''}`}
            onClick={() => onApply(emoji)}
            disabled={busy}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="avatar-upload-row">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Icon name="image" size={16} />
          {uploading ? '上传中...' : '上传图片'}
        </button>
        {value && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onApply('')}
            disabled={busy}
          >
            清除图标
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            upload(f);
          }}
        />
      </div>

      <div className="avatar-custom-hint">
        {hint || '支持 PNG / JPG / GIF / WebP / BMP / AVIF（手机相册 / 拍照均可，大图自动压缩），也可以直接选一个 emoji'}
      </div>
    </div>
  );
}