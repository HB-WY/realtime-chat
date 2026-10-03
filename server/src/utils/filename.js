// src/utils/filename.js
//
// multer/busboy 按 latin1 解析 filename，中文会乱码。
// 前端在 body.name 里显式传原名时优先使用。
//

function hasNonLatin1(str) {
  for (const ch of str) {
    if (ch.codePointAt(0) > 0xff) return true;
  }
  return false;
}

function fixFilename(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  if (hasNonLatin1(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return raw;
    return decoded;
  } catch {
    return raw;
  }
}

function pickOriginalName(req, fallbackRaw) {
  const fromBody = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (fromBody) return fromBody;
  return fixFilename(fallbackRaw);
}

module.exports = { hasNonLatin1, fixFilename, pickOriginalName };