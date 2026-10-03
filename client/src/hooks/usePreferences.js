// usePreferences.js
//
// 个性化偏好：全局背景 / 单房间背景 / 气泡配置 / 字号。
// 服务端存储 → 换设备登录自动同步。
// 未设置（null）时不注入任何 CSS 变量，界面与现状完全一致。
//
// [CHANGED] 不再需要 token 参数 —— http.js 从内存读 access。
//
import { useCallback, useEffect, useState } from 'react';
import { getPreferences, savePreferences } from '../api';

export const EMPTY_PREFS = {
  global: { background: null, bubble: null, fontSize: null, updatedAt: null },
  rooms: {},
  limits: { fontMin: 12, fontMax: 20, maxRooms: 200 }
};

/** '#112233' 直接用作颜色；'/uploads/...' 转成 url() */
export function toCssBackground(value) {
  if (!value) return null;
  return value.startsWith('/') || /^https?:\/\//.test(value)
    ? `url("${value}")`
    : value;
}

/**
 * 计算要挂到聊天区上的 CSS 变量。
 * 单房间背景优先于全局背景；其余（气泡、字号）为全局。
 */
export function buildAppearanceStyle(prefs, roomKey) {
  const style = {};
  if (!prefs) return style;

  const roomBg = roomKey ? prefs.rooms?.[roomKey]?.background : null;
  const bg = roomBg || prefs.global?.background || null;
  const bgCss = toCssBackground(bg);
  if (bgCss) {
    style['--chat-bg'] = bgCss;
    style.backgroundSize = 'cover';
    style.backgroundPosition = 'center';
    style.backgroundRepeat = 'no-repeat';
  }

  const fontSize = prefs.global?.fontSize;
  if (fontSize) style['--chat-font-size'] = `${fontSize}px`;

  const bubble = prefs.global?.bubble;
  if (bubble) {
    const sides = [
      ['other', '--bubble-other'],
      ['self', '--bubble-self']
    ];
    let radius = null;
    for (const [side, prefix] of sides) {
      const cfg = bubble[side];
      if (!cfg) continue;
      if (cfg.bg) style[`${prefix}-bg`] = cfg.bg;
      if (cfg.color) style[`${prefix}-color`] = cfg.color;
      if (cfg.border) style[`${prefix}-border`] = cfg.border;
      if (cfg.image) style[`${prefix}-image`] = `url("${cfg.image}")`;
      if (cfg.radius != null && radius == null) radius = cfg.radius;
    }
    if (radius != null) style['--bubble-radius'] = `${radius}px`;
  }

  return style;
}

export function usePreferences() {
  const [prefs, setPrefs] = useState(null);

  const reload = useCallback(async () => {
    try {
      const data = await getPreferences();
      setPrefs(data);
      return data;
    } catch {
      // 偏好加载失败不影响聊天，静默回落为「未设置」
      setPrefs(null);
      return null;
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async (payload) => {
    const data = await savePreferences(payload);
    setPrefs(data);
    return data;
  }, []);

  return { prefs, reload, save, setPrefs };
}