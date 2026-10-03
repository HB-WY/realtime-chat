import { useState } from 'react';
import * as session from '../../auth/session';
import { AVATAR_PRESETS } from '../../constants/avatars';
import Avatar from '../common/Avatar';

export default function LoginPage({ onSuccess }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // [CHANGED] 走 session：内部会存 accessToken 到内存 + 收 Refresh Cookie
      const data = mode === 'login'
        ? await session.login(username, password)
        : await session.register(username, password, nickname, avatar);
      onSuccess({ user: data.user });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m) => {
    setMode(m);
    setError('');
  };

  const previewName = nickname.trim() || username.trim() || '?';

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-logo">聊天系统</h1>

        <div className="tab-bar">
          <button
            type="button"
            className={`tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={`tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            className="auth-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
            maxLength={20}
          />

          {mode === 'register' && (
            <>
              <input
                className="auth-input"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="昵称（可选）"
                maxLength={20}
              />

              <div className="avatar-section">
                <div className="avatar-section-head">
                  <span className="avatar-section-title">选择头像（可选）</span>
                  <div className="avatar-preview">
                    <Avatar name={previewName} avatar={avatar} size={40} />
                  </div>
                </div>

                <div className="avatar-grid">
                  {AVATAR_PRESETS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`avatar-choice ${
                        avatar === emoji ? 'active' : ''
                      }`}
                      onClick={() =>
                        setAvatar((cur) => (cur === emoji ? '' : emoji))
                      }
                    >
                      {emoji}
                    </button>
                  ))}
                </div>

                <div className="avatar-custom-hint">
                  注册后可在「个人信息」中上传图片作为头像
                </div>
              </div>
            </>
          )}

          <input
            className="auth-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码（至少 6 位）"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          <div className="auth-error">{error}</div>

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  );
}