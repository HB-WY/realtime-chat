// src/middleware/upload.js
//
// 【本次改动】
//   · uploadAvatar 文件名补随机后缀（原先只有毫秒时间戳，
//     同一用户同毫秒两次上传会互相覆盖）
//   · uploadShopFile 补 BLOCKED_MIME 检查（原先只查扩展名，与
//     uploadFile 的 isDangerousUpload 不一致；纵深防御）
//
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

// ============================================================
// 确保上传目录存在
// ============================================================
for (const d of [
  config.AVATAR_DIR, config.FILE_DIR, config.SHOP_DIR,
  config.COVER_DIR, config.CUSTOM_DIR, config.TMP_DIR
]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ============================================================
// 危险上传判断（从 YAML 读黑名单）
// ============================================================
function isDangerousUpload(file) {
  const name = file.originalname || '';
  return config.BLOCKED_EXT.test(name) || config.BLOCKED_MIME.has(file.mimetype);
}

// ============================================================
// 头像白名单（从 YAML 读）
// ============================================================
const AVATAR_EXT_SET = new Set(
  (config.AVATAR_ALLOWED_EXT || []).map((e) => e.toLowerCase())
);
const AVATAR_MIME_PREFIX = config.AVATAR_ALLOWED_MIME_PREFIX;

function extLabel(set) {
  return [...new Set(
    [...set].map((e) => e.replace(/^\./, '').replace(/^jpeg$/, 'JPG').toUpperCase())
  )].join(' / ');
}
const AVATAR_FORMAT_MSG = `头像格式不支持（支持 ${extLabel(AVATAR_EXT_SET)}）`;

function randSuffix() {
  // [SEC] 文件名随机段改用 CSPRNG：Math.random() 可预测（约 41bit），
  //       /uploads/* 静态目录的安全性依赖「URL 不可猜测」，必须用足熵。
  return crypto.randomBytes(6).toString('hex');
}

// ============================================================
// 上传中间件
// ============================================================
const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const safe = AVATAR_EXT_SET.has(ext) ? ext : '.png';
      // [FIX] 随机后缀：与 uploadFile / uploadShopFile / uploadCover 对齐
      cb(null, `avatar_${req.user.id}_${Date.now()}_${randSuffix()}${safe}`);
    }
  }),
  limits: { fileSize: config.AVATAR_MAX },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/svg+xml') {
      return cb(new Error('不支持 SVG 头像'));
    }
    if (!file.mimetype.startsWith(AVATAR_MIME_PREFIX)) {
      return cb(new Error('只支持图片文件'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!AVATAR_EXT_SET.has(ext)) {
      return cb(new Error(AVATAR_FORMAT_MSG));
    }
    if (isDangerousUpload(file)) {
      return cb(new Error('不允许上传该类型文件'));
    }
    cb(null, true);
  }
});

const uploadFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.FILE_DIR),
    filename: (req, file, cb) => {
      const rawExt = path.extname(file.originalname) || '';
      const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt.toLowerCase() : '';
      cb(null, `${Date.now()}_${randSuffix()}${safeExt}`);
    }
  }),
  limits: { fileSize: config.FILE_MAX },
  fileFilter: (req, file, cb) => {
    if (isDangerousUpload(file)) {
      return cb(new Error('不允许上传该类型文件'));
    }
    cb(null, true);
  }
});

const uploadShopFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.SHOP_DIR),
    filename: (req, file, cb) => {
      const rawExt = path.extname(file.originalname) || '';
      const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt.toLowerCase() : '';
      cb(null, `${Date.now()}_${randSuffix()}${safeExt}`);
    }
  }),
  limits: { fileSize: config.SHOP_FILE_MAX },
  fileFilter: (req, file, cb) => {
    // [SEC] 与 uploadFile 对齐：ext + mime 双查
    if (isDangerousUpload(file)) {
      return cb(new Error('不允许上传该类型文件'));
    }
    cb(null, true);
  }
});

const uploadCover = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.COVER_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      const safe = AVATAR_EXT_SET.has(ext) ? ext : '.jpg';
      cb(null, `cover_${Date.now()}_${randSuffix()}${safe}`);
    }
  }),
  limits: { fileSize: config.COVER_MAX },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/svg+xml') return cb(new Error('不支持 SVG 封面'));
    if (!file.mimetype.startsWith(AVATAR_MIME_PREFIX)) return cb(new Error('封面必须是图片'));
    cb(null, true);
  }
});

// ============================================================
// 资源池上传（背景 / 气泡素材 / 表情图片）
//
// 先落到 TMP_DIR，由 services/assets.js 计算 sha256 去重后再搬运到
// uploads/custom/{userId}/ 或 uploads/custom/{userId}/sticker/
// ============================================================
const ASSET_MIME_SET = new Set(config.ASSETS_CFG.allowed_mime || []);
const ASSET_EXT_SET = new Set(
  (config.ASSETS_CFG.allowed_ext || []).map((e) => e.toLowerCase())
);
const ASSET_FORMAT_MSG = `只支持 ${extLabel(ASSET_EXT_SET)} 图片`;

const uploadAssets = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.TMP_DIR),
    filename: (req, file, cb) => {
      const rawExt = path.extname(file.originalname).toLowerCase();
      const safeExt = ASSET_EXT_SET.has(rawExt) ? rawExt : '.png';
      cb(null, `tmp_${Date.now()}_${randSuffix()}${safeExt}`);
    }
  }),
  limits: {
    fileSize: config.ASSET_MAX,
    files: config.ASSETS_CFG.max_files_per_request || 50
  },
  fileFilter: (req, file, cb) => {
    if (!ASSET_MIME_SET.has(file.mimetype)) {
      return cb(new Error(ASSET_FORMAT_MSG));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ASSET_EXT_SET.has(ext)) {
      return cb(new Error(ASSET_FORMAT_MSG));
    }
    cb(null, true);
  }
});

module.exports = {
  uploadAvatar, uploadFile, uploadShopFile, uploadCover, uploadAssets,
  isDangerousUpload
};