import { useEffect, useState, useCallback } from 'react';
import { getMyCapabilities } from '../api';

/**
 * 拉取当前用户的能力表，提供 can(cap) 助手。
 * 在 ChatRoom 里用一次，向下传。
 *
 * [CHANGED] 不再需要 token 参数 —— http.js 从内存读 access。
 */
export function useRole() {
  const [state, setState] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getMyCapabilities();
      setState(data);
    } catch (err) {
      console.error('[useRole]', err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const can = useCallback((cap) => !!state?.capabilities?.[cap], [state]);

  return {
    role: state?.role || 'user',
    label: state?.label || '',
    level: state?.level ?? 0,
    can,
    grantable: state?.grantable || [],
    refresh
  };
}