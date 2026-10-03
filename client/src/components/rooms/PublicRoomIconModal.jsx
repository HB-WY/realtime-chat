import { useEffect, useState } from 'react';
import { setPublicRoomIcon } from '../../api';
import Avatar from '../common/Avatar';
import RoomIconEditor from '../common/RoomIconEditor';

/**
 * 公共聊天图标设置（整页）。
 * 只有持有 manage_public_room 能力的角色（默认＝开发者）能打开；
 * 服务端仍会再次校验，前端只是入口。
 *
 * [CHANGED] 认证改造：不再接收 token prop。RoomIconEditor 内部调
 *   uploadAvatar 时也不再需要 token（http.js 从 auth/session.js 读 Access）。
 */
export default function PublicRoomIconModal({ room, onClose, onSaved }) {
  // 打开时以服务端返回的当前图标为初值；之后本地保存立即回显
  const [icon, setIcon] = useState(room?.icon || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const apply = async (next) => {
    setSaving(true);
    setError('');
    try {
      const data = await setPublicRoomIcon(next);
      setIcon(data?.room?.icon || '');
      onSaved?.(data?.room);
    } catch (err) {
      setError(err.message || '设置失败');
    } finally {
      setSaving(false);
    }
  };

  const roomName = room?.name || '公共聊天';

  return (
    <div className="modal-overlay" onMouseDown={() => !saving && onClose()}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">公共聊天图标</span>
          <button className="icon-btn" onClick={onClose} disabled={saving} aria-label="关闭">
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

        <div className="group-info-head">
          <Avatar name={roomName} avatar={icon} size={64} />
          <div className="group-info-name">{roomName}</div>
          <div className="group-info-sub">所有用户都能看到这个图标</div>
        </div>

        <label className="modal-label">选择图标</label>
        <RoomIconEditor
          name={roomName}
          value={icon}
          onApply={apply}
          onError={setError}
          disabled={saving}
          hint="仅开发者可修改 · 选 emoji 或上传图片（手机相册 / 拍照均可，大图自动压缩）"
        />

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            {saving ? '保存中...' : '完成'}
          </button>
        </div>
      </div>
    </div>
  );
}