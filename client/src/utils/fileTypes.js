// client/src/utils/fileTypes.js
//
// 文件类型注册表：**唯一的真相**。
//
//   · 内置 11 类硬编码在这里（word/excel/ppt/pdf/text/code/archive/audio/video/image/file）
//   · 开发者新增/覆盖的类型由后端下发（config.yaml → files.types，
//     见 server/src/routes/fileTypes.js），启动后拉一次并入本表，**自定义优先**
//
// 为什么要「拉取 + 订阅」而不是塞进构建产物：开发者改完 config.yaml 重启后端即生效，
// 不用重新构建前端。图标是同步渲染的，所以这里用 useSyncExternalStore 的
// 订阅机制让已渲染的图标在注册表更新后自动重画（见 FileTypeIcon.jsx）。
//
// [CHANGED] loadFileTypes 不再需要 token 参数 —— 认证改造后 http.js 从
//   auth/session.js 的内存里读 Access Token。
//
import { request } from '../api/http';
import { isImageRef } from './media';

/** 内置类型的扩展名 → key。数组顺序只为人眼阅读，查表是 O(1) */
const EXT_GROUPS = [
  ['word', ['doc', 'docx', 'rtf', 'odt']],
  ['excel', ['xls', 'xlsx', 'csv', 'ods']],
  ['ppt', ['ppt', 'pptx', 'odp']],
  ['pdf', ['pdf']],
  ['text', ['txt', 'md', 'log', 'ini', 'conf', 'cfg']],
  [
    'code',
    [
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp',
      'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'html', 'htm', 'css', 'scss',
      'less', 'json', 'xml', 'yml', 'yaml', 'sh', 'bash', 'sql', 'vue', 'svelte'
    ]
  ],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpeg', 'mpg']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico']]
];

/** 内置类型的角标与主色（颜色沿用既有取色，全站一致） */
const BUILTIN_KINDS = {
  word: { label: 'DOC', color: '#2b579a' },
  excel: { label: 'XLS', color: '#217346' },
  ppt: { label: 'PPT', color: '#d24726' },
  pdf: { label: 'PDF', color: '#e33e33' },
  text: { label: 'TXT', color: '#6b7280' },
  code: { label: 'CODE', color: '#0ea5e9' },
  archive: { label: 'ZIP', color: '#f0a500' },
  audio: { label: 'AUD', color: '#8b5cf6' },
  video: { label: 'VID', color: '#ec4899' },
  image: { label: 'IMG', color: '#22a06b' },
  file: { label: 'FILE', color: '#94a3b8' }
};

/** mime 兜底：扩展名认不出时的次级判断（text/* 放最后，避免吃掉更具体的类型） */
const MIME_RULES = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
  ['application/pdf', 'pdf'],
  ['application/zip', 'archive'],
  ['application/x-rar', 'archive'],
  ['application/x-7z-compressed', 'archive'],
  ['text/', 'text']
];

const BUILTIN_EXT_TO_KIND = new Map(
  EXT_GROUPS.flatMap(([kind, exts]) => exts.map((ext) => [ext, kind]))
);

// ---------- 开发者自定义类型 ----------
// ext → 类型定义；key → 类型定义。自定义的 ext 覆盖内置。
let customByExt = new Map();
let customByKey = new Map();
let version = 0;
const listeners = new Set();

function emit() {
  version += 1;
  for (const cb of listeners) cb();
}

/** 给 useSyncExternalStore 用：注册表变化时让已渲染的图标重画 */
export function subscribeFileTypes(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function fileTypesVersion() {
  return version;
}

/**
 * 并入后端下发的自定义类型。
 * 只接受形状正确的条目；cover 必须是「像图片的地址」，
 * 否则忽略（宁可掉回内置图形，也不要渲染出裂图）。
 */
export function applyCustomTypes(list) {
  const byExt = new Map();
  const byKey = new Map();
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t.key !== 'string' || !t.key) continue;
    const def = {
      key: t.key,
      label: (typeof t.label === 'string' && t.label) || t.key.toUpperCase(),
      color: (typeof t.color === 'string' && t.color) || '#64748b',
      cover: typeof t.cover === 'string' && isImageRef(t.cover) ? t.cover : null
    };
    byKey.set(def.key, def);
    for (const ext of Array.isArray(t.exts) ? t.exts : []) {
      const e = String(ext || '').toLowerCase().replace(/^\.+/, '');
      if (e) byExt.set(e, def);
    }
  }
  customByExt = byExt;
  customByKey = byKey;
  emit();
}

let loadPromise = null;
/** 登录后拉一次并缓存（同一会话内只请求一次；失败则静默用内置表）
 *
 * [CHANGED] 不再需要 token 参数 —— http.js 从内存读 access。
 */
export function loadFileTypes() {
  if (loadPromise) return loadPromise;
  loadPromise = request('/file-types')
    .then((data) => applyCustomTypes(data?.types))
    .catch(() => {
      // 拉不到就用内置表：图标退化成通用图形，不影响功能
      loadPromise = null;
    });
  return loadPromise;
}

/** 仅供测试/登出时重置 */
export function resetFileTypes() {
  customByExt = new Map();
  customByKey = new Map();
  loadPromise = null;
  emit();
}

function extensionOf(name) {
  if (typeof name !== 'string') return '';
  const raw = name.trim();
  const dot = raw.lastIndexOf('.');
  // dot <= 0 覆盖两种情况：没有点，或点是第 0 位（.gitignore 这类隐藏文件不算扩展名）
  if (dot <= 0 || dot === raw.length - 1) return '';
  return raw.slice(dot + 1).toLowerCase();
}

function kindFromMime(mime) {
  if (typeof mime !== 'string') return null;
  const type = mime.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9.+/-]/g, '');
  if (!type) return null;
  const hit = MIME_RULES.find(([prefix]) => type.startsWith(prefix));
  return hit ? hit[1] : null;
}

/**
 * 按文件名/扩展名与 MIME 归类。
 * 优先级：开发者自定义扩展名 → 内置扩展名 → MIME 兜底 → 'file'。
 * @returns {{ key: string, label: string, color: string, cover: string|null }}
 */
export function fileKind(name, mime) {
  const ext = extensionOf(name);
  const custom = ext ? customByExt.get(ext) : null;
  if (custom) return custom;

  const key = BUILTIN_EXT_TO_KIND.get(ext) || kindFromMime(mime) || 'file';
  const builtin = BUILTIN_KINDS[key] || BUILTIN_KINDS.file;
  // 开发者可以用同名的 key 覆盖内置类型（例如给 video 换一张封面）
  const override = customByKey.get(key);
  if (override) return override;
  return { key, label: builtin.label, color: builtin.color, cover: null };
}