// client/src/App.jsx
//
// 顶层组件：管理"会话状态"（未登录 / 已登录）+ 全局 401 事件。
//
// [SEC] 启动流程：
//   1) 先读本地缓存的 user（用于立即渲染首屏，减少白屏）
//   2) 再调 session.refresh() 拿真 Access；成功 → authed，失败 → guest
//   3) 页面刷新后内存里没有 access，靠 Refresh Cookie 换回
//
import { useEffect, useState } from 'react';
import LoginPage from './components/auth/LoginPage';
import ChatRoom from './components/chat/ChatRoom';
import { loadAuth, clearAuth } from './utils/authStorage';
import { loadFileTypes, resetFileTypes } from './utils/fileTypes';
import * as session from './auth/session';

export default function App() {
  // phase: 'booting' | 'guest' | 'authed'
  const [phase, setPhase] = useState('booting');
  const [user, setUser] = useState(null);

  // ---------- 启动：刷新会话 ----------
  useEffect(() => {
    let alive = true;

    // 缓存里的 user 先垫一下首屏（真伪无所谓，只影响显示）
    const cached = loadAuth();
    if (cached?.user) setUser(cached.user);

    (async () => {
      try {
        const d = await session.refresh();
        if (!alive) return;
        setUser(d.user);
        setPhase('authed');
        loadFileTypes();
      } catch {
        if (!alive) return;
        clearAuth();
        setUser(null);
        setPhase('guest');
      }
    })();

    return () => { alive = false; };
  }, []);

  // ---------- 全局 401：清状态回登录页 ----------
  useEffect(() => {
    const onExpired = () => {
      clearAuth();
      resetFileTypes();
      setUser(null);
      setPhase('guest');
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  // ---------- 登录成功（LoginPage 回调） ----------
  const handleLoginSuccess = (data) => {
    setUser(data.user);
    setPhase('authed');
    loadFileTypes();
  };

  // ---------- 登出 ----------
  const handleLogout = async () => {
    await session.logout();
    clearAuth();
    resetFileTypes();
    setUser(null);
    setPhase('guest');
  };

  // ---------- 渲染 ----------
  if (phase === 'booting') return null;
  if (phase === 'guest' || !user) {
    return <LoginPage onSuccess={handleLoginSuccess} />;
  }

  return (
    <ChatRoom
      user={user}
      onUserUpdate={(newUser) => {
        if (
          user.nickname === newUser.nickname &&
          user.avatar === newUser.avatar &&
          user.role === newUser.role &&
          (user.signature || '') === (newUser.signature || '')
        ) return;
        const next = { ...user, ...newUser };
        session.setUser(next);
        setUser(next);
      }}
      onLogout={handleLogout}
    />
  );
}