import { useState, useRef, useEffect } from 'react';
import { updateProfile, uploadAvatar } from '../../api';
import { AVATAR_PRESETS } from '../../constants/avatars';
import Avatar from '../common/Avatar';
import Icon from '../common/Icon';

// [FIX] 移除 token prop。
//   认证改造后（Access 内存 + HttpOnly Cookie）所有 API 都从
//   client/src/api/http.js 内部读 `auth/session.js` 的内存 Access，
//   函数签名早就改成了「不含 token」：
//     · uploadAvatar(file)
//     · updateProfile(payload)
//   本组件此前仍按旧签名调用 `uploadAvatar(token, file)` /
//   `updateProfile(token, {...})` —— 第一个参数被当成 file / payload，
//   实际拿到的是 undefined：
//     · 上传：fd.append('avatar', undefined) 直接抛错 → 用户看到"上传失败"
//     · 保存：payload=undefined → PATCH /me 无 body → 400
//   ChatRoom 调用点也从来不传 token，所以整个个人信息页是坏的。
export default function AvatarEditor({ user, onSaved, onClose }) {
  const [nickname, setNickname] = useState(user.nickname || '');
  const [avatar, setAvatar] = useState(user.avatar || '');
  // 【新增】个性签名
  const [signature, setSignature] = useState(user.signature || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving && !uploading) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving, uploading]);

  const handleUpload = async (file) => {
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      // [FIX] 不再传 token：http.js 从 auth/session.js 内存里读 Access。
      const data = await uploadAvatar(file);
      setAvatar(data.url);
    } catch (err) {
      setError(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      // [FIX] 同上：payload 是唯一参数。
      // 【新增】一并提交个性签名。
      const data = await updateProfile({ nickname, avatar, signature });
      onSaved(data.user);
      onClose();
    } catch (err) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const previewName = nickname.trim() || user.nickname;
  const busy = saving || uploading;

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">个人信息</span>
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
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

        <div className="modal-preview">
          <Avatar name={previewName} avatar={avatar} size={84} />
          <div className="modal-preview-name">{previewName}</div>
        </div>

        <label className="modal-label">昵称</label>
        <input
          className="auth-input"
          value={nickname}
          maxLength={20}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="输入昵称"
        />

        {/* 【新增】个性签名：展示在用户卡片与消息栏 */}
        <label className="modal-label">个性签名</label>
        <textarea
          className="auth-input signature-input"
          value={signature}
          maxLength={60}
          rows={2}
          onChange={(e) => setSignature(e.target.value)}
          placeholder="写点什么介绍自己吧（60 字以内）"
        />

        <label className="modal-label">
          头像 · 选择一个图标，或上传图片
        </label>

        <div className="avatar-editor">
          <div className="avatar-grid">
            {AVATAR_PRESETS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={`avatar-choice ${avatar === emoji ? 'active' : ''}`}
                onClick={() => setAvatar((cur) => (cur === emoji ? '' : emoji))}
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
            {avatar && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAvatar('')}
                disabled={busy}
              >
                清除头像
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
                handleUpload(f);
              }}
            />
          </div>

          <div className="avatar-custom-hint">
            支持 PNG / JPG / GIF / WebP / BMP / AVIF；手机相册 / 拍照都能选，大图自动压缩。上传后与昵称一同保存
          </div>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="auth-submit" onClick={handleSave} disabled={busy}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}