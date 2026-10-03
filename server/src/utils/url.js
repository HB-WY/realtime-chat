// src/utils/url.js
//
// 图片类 URL 的统一校验（商品封面 / 表情包封面 / 其它需要落库后由前端
// 渲染进 <img src> 的地址）。
//
// [SEC] 这些字段原先都是客户端直传、原样入库。虽然 <img src> 不会执行脚本，
//       但放行任意外部 scheme 等于接受一个不受控的注入面（外链跟踪、
//       未来若改成 <a href> 就变成真 XSS）。统一收口到这里。
//
const UPLOAD_RE = /^\/uploads\/[A-Za-z0-9_\-./]+$/;
const MAX_URL_LEN = 500;
const MAX_DATA_URL_LEN = 200000;

/**
 * @param {*} raw              原始值；null / undefined / '' → 返回 null（清除）
 * @param {string} field       报错文案里的字段名
 * @returns {string|null}
 */
function normalizeImageUrl(raw, field = '图片地址') {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new Error(`${field}不合法`);
  const s = raw.trim();
  if (!s) return null;

  // 站内上传：/uploads/... （显式拒绝 .. 越界）
  if (UPLOAD_RE.test(s) && !s.includes('..')) return s;

  // 外链图片：与头像同一策略
  if (/^https?:\/\//i.test(s)) {
    if (s.length > MAX_URL_LEN) throw new Error(`${field}过长`);
    return s;
  }

  // 内联图片
  if (/^data:image\//i.test(s)) {
    if (s.length > MAX_DATA_URL_LEN) throw new Error(`${field}过长`);
    return s;
  }

  throw new Error(`${field}只支持 /uploads/ 图片、http(s) 链接或 data:image`);
}

module.exports = { normalizeImageUrl, MAX_URL_LEN, MAX_DATA_URL_LEN };
