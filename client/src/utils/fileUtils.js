/** 人类可读的文件大小 */
export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 文件类型的图标 / 标签 / 配色统一由 components/common/FileTypeIcon.jsx 提供
// （fileKind() + <FileTypeIcon/>）。这里曾有一份 getFileMeta()/getShopFileIcon()
// 的「字母方块」实现，已删除：两套并存必然漂移，且要求用 SVG 而不是文字标签。