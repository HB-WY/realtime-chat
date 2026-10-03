const MEDIA_BASE = ''; // 上传文件的 URL 前缀（/uploads/... 直接是相对路径）

/**
 * 把后端返回的路径转成可访问 URL。
 * /uploads/... 是相对路径，浏览器打当前 origin，代理转发到后端。
 */
export function resolveMediaUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//.test(p) || p.startsWith('data:')) return p;
  return `${MEDIA_BASE}${p}`;
}

/** 与后端 sanitizeAvatar 一致：只把 /uploads/、http(s)、data:image/ 当作图片 */
export function isImageRef(s) {
  return (
    /^\/uploads\//.test(s) ||
    /^https?:\/\//.test(s) ||
    /^data:image\//.test(s)
  );
}

// ============================================================
// 转码（本地 ffmpeg）相关
// ============================================================
// 播放状态机与「哪些扩展名要先去问后端」都在 `utils/mediaPlayback.js`（纯函数，
// 零 import，能被 Node 回归脚本直接 import）。这里只留渲染层用的格式化。

/** 转码进度（0-1）→ 给用户看的百分比文案 */
export function formatTranscodeProgress(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return '';
  return `${Math.round(Math.min(p, 0.99) * 100)}%`;
}