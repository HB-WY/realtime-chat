// client/src/utils/image.js
//
// 上传前的**图片规范化**。手机照片会同时撞上三件事，这里一次性解决：
//
//   1) 体积 —— 手机直出 3–12MB，而头像上限只有 5MB，用户看到的是
//      「头像不能超过 5MB」，一张自拍都传不上去。
//   2) 方向 —— 手机靠 EXIF Orientation 标记方向。浏览器显示时会自动转正，
//      但一旦重新编码就会丢掉这个标记 → 必须**按方向解码**再画，
//      否则上传成功后照片是横躺的。
//   3) 格式 —— iPhone 默认拍 HEIC/HEIF，服务端按扩展名 + MIME 白名单收，
//      直接拒。能解码的在手机端就地转成 JPEG（所以手机上传反而没问题）；
//      解不开的（桌面浏览器）给出**可执行**的提示，而不是干巴巴一句「格式不支持」。
//
// 不碰的情况：GIF（重编码会丢动画）、SVG（服务端明确不支持，交给服务端报错）、
// 非图片文件（聊天附件里的任意文件原样上传）。
//
// 用法：
//   const f = await prepareImage(file, { maxDim: 1024, maxBytes: 3.5 * MB, label: '头像' });

export const IMAGE_ACCEPT = 'image/*';

export const MB = 1024 * 1024;

/** 规范化失败（可据此给用户提示，或决定是否继续用原文件） */
export class ImagePrepareError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImagePrepareError';
    this.code = code;
  }
}

// 重编码会破坏它们：GIF 丢动画，SVG 是矢量且服务端不收
const PASSTHROUGH_EXT = /\.(gif|svg)$/i;
const PASSTHROUGH_MIME = new Set(['image/gif', 'image/svg+xml']);

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

function isPassthrough(file) {
  return PASSTHROUGH_MIME.has((file.type || '').toLowerCase()) || PASSTHROUGH_EXT.test(file.name || '');
}

/**
 * 解码成可绘制的位图。
 * 优先 createImageBitmap（可显式要求应用 EXIF 方向）；失败再退到 <img>。
 * 两者都失败 → 抛 UNDECODABLE（典型场景：桌面浏览器遇到 HEIC）。
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* 换 <img> 再试 */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePrepareError('decode failed', 'UNDECODABLE'));
    };
    // 现代浏览器 drawImage 会按 EXIF 方向绘制
    img.src = url;
  });
}

/** 粗判是否有透明像素（只看 64×64 的缩略图，够用且很便宜） */
function hasAlpha(bitmap) {
  try {
    const N = 64;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
    return false;
  } catch {
    return false;
  }
}

function drawToCanvas(bitmap, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImagePrepareError('无法编码图片', 'ENCODE_FAILED'))),
      type,
      quality
    );
  });
}

function renameExt(name, ext) {
  const base = (name || 'image').replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'image';
  return `${base}${ext}`;
}

/**
 * 把一张图片处理成「尺寸受限、体积受限、方向正确」的 File。
 *
 * @param {File} file
 * @param {object} [opts]
 * @param {number} [opts.maxDim]    最长边上限（px）
 * @param {number} [opts.maxBytes]  体积上限（字节）
 * @param {number} [opts.quality]   JPEG 起始质量
 * @param {string} [opts.label]     出错提示里的称呼，如「头像」「背景图」
 * @returns {Promise<File>} 处理后的文件；无需处理时原样返回
 */
export async function prepareImage(file, {
  maxDim = 2560,
  maxBytes = 8 * MB,
  quality = 0.85,
  label = '图片'
} = {}) {
  if (!isImageFile(file)) return file;
  if (isPassthrough(file)) return file;

  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new ImagePrepareError(
      `${label}无法解码：这是浏览器不支持的图片格式（常见于 iPhone 的 HEIC/HEIF，以及 TIFF 等）。` +
      '可以先把照片在相册里「编辑 → 完成」另存为 JPEG，' +
      '或把手机「设置 → 相机 → 格式」改成「兼容性最佳」，再重新选择。',
      'UNDECODABLE'
    );
  }

  const sw = bitmap.width || 1;
  const sh = bitmap.height || 1;

  // 尺寸与体积都合适 → 原样上传（保住原始画质与透明通道，也省一次编码）
  if (sw <= maxDim && sh <= maxDim && file.size <= maxBytes) {
    if (typeof bitmap.close === 'function') bitmap.close();
    return file;
  }

  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const usePng = hasAlpha(bitmap);
  const type = usePng ? 'image/png' : 'image/jpeg';

  let w = Math.max(1, Math.round(sw * scale));
  let h = Math.max(1, Math.round(sh * scale));
  let q = quality;
  let blob = null;

  // 先降质量，再降尺寸；最多 4 轮，保证收敛
  for (let round = 0; round < 4; round++) {
    blob = await canvasToBlob(drawToCanvas(bitmap, w, h), type, q);
    if (blob.size <= maxBytes) break;
    if (!usePng && q > 0.55) q -= 0.1;
    else {
      w = Math.max(1, Math.round(w * 0.75));
      h = Math.max(1, Math.round(h * 0.75));
      q = quality;
    }
  }

  if (typeof bitmap.close === 'function') bitmap.close();

  const ext = usePng ? '.png' : '.jpg';
  return new File([blob], renameExt(file.name, ext), {
    type,
    lastModified: file.lastModified || Date.now()
  });
}

/** 多文件版本（表情包 / 资源池批量上传）。顺序处理，避免同时开一堆 canvas。 */
export async function prepareImages(files, opts) {
  const out = [];
  for (const f of Array.from(files || [])) {
    out.push(await prepareImage(f, opts));
  }
  return out;
}
