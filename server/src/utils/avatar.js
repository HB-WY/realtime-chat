// src/utils/avatar.js
//
// 头像 / 房间图标的统一净化规则。
//
// [SEC] 这个函数是「把用户输入落库为 avatar 字段」的**唯一出口**，
//       而下游 routes/user.js::PATCH /me 会用 row.avatar 直接
//       path.join + fs.unlinkSync 删除旧头像文件 —— 一旦这里放行 `..`，
//       就变成「认证用户可以删除服务器任意文件」。所以站内路径
//       `/uploads/...` 必须显式拒绝 `.` / `..` 段
//       （与 services/assets.js 的 absFromUrl、utils/url.js 的
//        normalizeImageUrl 口径一致）。
//
const config = require('../config');

const MAX_DATA_URL_LEN = config.AVATAR_MAX_DATA_URL_LEN;
const MAX_URL_LEN      = config.AVATAR_MAX_URL_LEN;

function firstGrapheme(s) {
  if (typeof s !== 'string' || !s) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
      const it = seg.segment(s)[Symbol.iterator]();
      const first = it.next();
      return first.done ? '' : first.value.segment;
    } catch {
      // fallthrough
    }
  }
  return Array.from(s)[0] || '';
}

/**
 * 站内路径里是否含 `.` / `..` 段（含 Windows 反斜杠写法）。
 * 与 services/assets.js::absFromUrl 的口径一致：逐段严格比对。
 */
function hasUnsafeSegments(rel) {
  return String(rel).split(/[\\/]+/).some((seg) => seg === '.' || seg === '..');
}

function sanitizeAvatar(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  // 1) 站内上传路径 /uploads/...
  //    [SEC] 除长度外**必须**显式拒绝 `..` —— 见文件顶部说明。
  if (/^\/uploads\//.test(s)) {
    if (s.length > MAX_URL_LEN) return '';
    if (hasUnsafeSegments(s)) return '';
    return s;
  }

  // 2) 外链 http(s)://... —— URL 里的 `..` 会被浏览器自行规范化，
  //    不构成文件系统层面的路径穿越，仍只做长度限制。
  if (/^https?:\/\//.test(s)) {
    return s.length > MAX_URL_LEN ? '' : s;
  }

  // 3) 内联 data:image/...
  if (/^data:image\//.test(s)) {
    return s.length > MAX_DATA_URL_LEN ? '' : s;
  }

  // 4) 单个 emoji / 字符
  return firstGrapheme(s);
}

module.exports = { sanitizeAvatar, firstGrapheme, hasUnsafeSegments };