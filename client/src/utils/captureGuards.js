// client/src/utils/captureGuards.js
//
// 「防随手抓取」的两道**前端**守卫：
//   1) 键盘守卫：拦 F12、Ctrl+Shift+I/J/C（开发者工具 / 审查元素）、Ctrl+U（查看源码）、Ctrl+S（保存页面）；
//   2) 右键守卫：**全站禁用浏览器默认右键菜单**（应用自己的自定义菜单不受影响 —— 见下）。
//
// [SEC] 先把话说清楚 —— 它们能做什么、不能做什么：
//   · 能：让**普通用户**按不出来、点不出来。仅此而已。
//   · 不能：浏览器菜单「更多工具 → 开发者工具」照样打开；换个浏览器、禁用 JS、
//     或者直接 `curl` 接口更是完全不受影响。**它们拦不住任何一个稍微懂行的人。**
//   所以这是**劝退级**手段，必须和 ProtectedImage（图片右键 / 拖拽拦截）以及
//   服务端限流一起用，目标只是「让顺手拿走变麻烦」。
//
// 右键守卫的两个要点（都踩过）：
//   · **只 preventDefault，绝不 stopPropagation**：应用自己的右键菜单（聊天消息的
//     ContextMenu）挂在 React 的 `onContextMenu` 上，靠**冒泡**触发。一旦拦了冒泡，
//     自定义菜单就一起没了 —— 而需求恰恰是「除自定义菜单外全禁」。
//   · **输入框 / 可编辑区域豁免**：右键粘贴、拼写检查是正常需求；手机端长按粘贴
//     更是唯一的粘贴方式（没有 Ctrl+V）。拦了它，用户连密码/密钥都粘不进去。
//     要「连输入框也拦」，把 MENU_EXEMPT_SELECTOR 置空即可。
//
// 逃生口（给开发者自己，浏览器里右键审查元素是刚需）：
//   · `npm run dev` 下**根本不装**；
//   · 生产构建里带 `?dev=1` 打开页面即可跳过。
//
const CTRL_ONLY_KEYS = new Set(['U', 'S']);          // 配合 Ctrl/Cmd
const CTRL_SHIFT_KEYS = new Set(['I', 'J', 'C']);    // 配合 Ctrl/Cmd + Shift

/**
 * 右键菜单豁免选择器：这些地方的浏览器默认菜单**保留**（粘贴 / 拼写检查）。
 * 置为空字符串即「连输入框也不给菜单」。
 */
export const MENU_EXEMPT_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * 装上键盘守卫（可单独用于测试）。
 * @param {Window|{addEventListener:Function, removeEventListener:Function}} target
 * @returns {() => void} 卸载函数
 */
export function installKeyboardGuards(target = window) {
  const onKeyDown = (e) => {
    const key = String(e.key || '').toUpperCase();
    const mod = e.ctrlKey || e.metaKey;
    const hit =
      key === 'F12'
      || (mod && e.shiftKey && CTRL_SHIFT_KEYS.has(key))
      || (mod && !e.shiftKey && CTRL_ONLY_KEYS.has(key));
    if (!hit) return;
    // 捕获阶段拦，先于页面里其它 keydown 逻辑
    e.preventDefault();
    e.stopPropagation();
  };
  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}

/**
 * 全站禁用浏览器默认右键菜单（应用自定义菜单照常）。
 * @param {Window|{addEventListener:Function, removeEventListener:Function}} target
 * @param {{exemptSelector?:string}} [opts] exemptSelector 传空串 = 连输入框也拦
 * @returns {() => void} 卸载函数
 */
export function installContextMenuGuard(target = window, { exemptSelector = MENU_EXEMPT_SELECTOR } = {}) {
  const onContextMenu = (e) => {
    const el = e.target;
    if (exemptSelector && el && typeof el.closest === 'function' && el.closest(exemptSelector)) {
      return;   // 输入框 / 可编辑区域：保留系统菜单（右键粘贴、拼写检查）
    }
    // 只拦「浏览器默认菜单」；不 stopPropagation，应用自己的 onContextMenu 仍会触发
    e.preventDefault();
  };
  target.addEventListener('contextmenu', onContextMenu, true);
  return () => target.removeEventListener('contextmenu', onContextMenu, true);
}

let installed = false;

/**
 * 应用启动时装一次（main.jsx 调用）：键盘守卫 + 全站右键守卫。
 * @returns {boolean} 是否真的装上了
 */
export function installCaptureGuards() {
  if (installed) return false;
  if (import.meta.env.DEV) return false;   // 开发时别拦自己（右键审查元素是刚需）
  try {
    if (new URLSearchParams(window.location.search).has('dev')) return false;
  } catch {
    /* 取不到 query 就算了，继续装 */
  }
  installKeyboardGuards(window);
  installContextMenuGuard(window);
  installed = true;
  return true;
}
