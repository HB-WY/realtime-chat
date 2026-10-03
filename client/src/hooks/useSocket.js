// client/src/hooks/useSocket.js
//
// Socket 连接。
//
// [SEC] Socket 握手时把 Access Token 放到 `auth.token` —— Access 不在 Cookie
//       里，只能这么传。Access 过期后**已建立的连接不受影响**；重连时先让
//       session 刷新一次拿新 access。
//
import { useEffect, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import * as session from '../auth/session';

export function useSocket() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    let disposed = false;

    // 拿（或刷新）一次 Access Token 再连
    async function connectWithFreshToken() {
      let token = session.getAccessToken();
      if (!token) {
        try { await session.refresh(); token = session.getAccessToken(); }
        catch { return; } // 未登录：不连
      }
      if (disposed || !token) return;

      const s = io({
        auth: { token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000
      });

      s.on('connect', () => setConnected(true));
      s.on('disconnect', () => setConnected(false));

      // [SEC] token 过期 / 账号被禁时，服务端握手会回认证类错误。
      //   识别后：先尝试刷新；刷新失败就派发 auth:expired 并停止重连。
      s.on('connect_error', async (err) => {
        setConnected(false);
        const msg = String(err?.message || '');
        if (/登录已过期|未登录|用户不存在|已被禁用/.test(msg)) {
          try {
            await session.refresh();
            // 刷新成功 → 用新 token 重连
            s.auth = { token: session.getAccessToken() };
            s.connect();
          } catch {
            try { s.disconnect(); } catch { /* ignore */ }
            window.dispatchEvent(new CustomEvent('auth:expired'));
          }
        }
      });

      socketRef.current = s;
      setSocket(s);
    }

    connectWithFreshToken();

    return () => {
      disposed = true;
      const s = socketRef.current;
      if (s) s.disconnect();
      socketRef.current = null;
      setSocket(null);
      setConnected(false);
    };
  }, []);

  const emit = useCallback((event, ...args) => {
    const s = socketRef.current;
    if (s) s.emit(event, ...args);
  }, []);

  return { socket, connected, emit };
}