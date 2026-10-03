import { useEffect, useRef, useState } from 'react';
import { listAssets, uploadAssets, deleteAsset } from '../../api';
import { resolveMediaUrl } from '../../utils/media';
import { formatSize } from '../../utils/fileUtils';
import { IMAGE_ACCEPT } from '../../utils/image';

// 类型筛选：全部 / 背景 / 气泡 / 表情
const TABS = [
  { key: 'all', label: '全部', kind: null },
  { key: 'background', label: '背景', kind: 'background' },
  { key: 'bubble', label: '气泡', kind: 'bubble' },
  { key: 'sticker', label: '表情', kind: 'sticker' }
];

// 上传时可选的目标类型（与后端 assets.KINDS 对应）
const UPLOAD_KINDS = [
  { key: 'background', label: '背景' },
  { key: 'bubble', label: '气泡' },
  { key: 'sticker', label: '表情' }
];

const KIND_LABEL = {
  image: '图片',
  background: '背景',
  bubble: '气泡',
  sticker: '表情'
};

const MB = 1024 * 1024;
const DEFAULT_MAX_FILE = 500 * MB; // 后端默认单文件 500MB（配额默认不限总量）

/** 字节 → MB（保留一位小数，去掉多余的 .0） */
function toMb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '0';
  return String(Number((bytes / MB).toFixed(1)));
}

/** 资源来源标签 */
function sourceLabel(source) {
  return { upload: '上传', purchase: '购买', subscribe: '订阅' }[source] || source || '上传';
}

/**
 * 我的资源库（整页）。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function AssetLibraryModal({ onClose, onChanged }) {
  const [tab, setTab] = useState('all');
  const [assets, setAssets] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);

  const [uploadKind, setUploadKind] = useState('background');
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');

  const fileRef = useRef(null);

  const currentKind = TABS.find((t) => t.key === tab)?.kind ?? null;

  const load = async (kind) => {
    setLoading(true);
    try {
      const d = await listAssets(kind);
      setAssets(d?.assets || []);
      setUsage(d?.usage || null);
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  // 切换类型时重新拉取
  useEffect(() => {
    load(currentKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Esc 关闭弹窗（与其它弹窗一致）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleUpload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setStatus('');
    try {
      const res = await uploadAssets(files, uploadKind);
      setStatus(
        `上传完成：新增 ${res?.created ?? 0} 个，去重 ${res?.deduped ?? 0} 个`
      );
      if (res?.usage) setUsage(res.usage);
      await load(currentKind);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (asset) => {
    const name = asset.name || '该图片';
    if (!confirm(`确定删除「${name}」？`)) return;
    try {
      const res = await deleteAsset(asset.id);
      if (res?.usage) setUsage(res.usage);
      await load(currentKind);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const used = usage?.used ?? 0;
  // [CHANGED] 后端 quota_bytes ≤ 0 表示不限总量（默认配置已改为 0）
  const quota = usage?.quota ?? 0;
  const quotaUnlimited = !quota || quota <= 0;
  const fileCount = usage?.files ?? 0;
  const maxFileSize = usage?.maxFileSize ?? DEFAULT_MAX_FILE;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card ast-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">我的资源库</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="ast-header">
          <div className="ast-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`ast-tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="ast-quota">
            <span className="ast-quota-main">
              {quotaUnlimited
                ? `已用 ${toMb(used)} MB（总量不限）`
                : `已用 ${toMb(used)} MB / ${toMb(quota)} MB`}
            </span>
            <span className="ast-quota-sub">
              {fileCount} 个文件 · 单文件 ≤{toMb(maxFileSize)} MB · 大图自动压缩
            </span>
          </div>
        </div>

        <div className="ast-upload">
          <select
            className="auth-input ast-kind"
            value={uploadKind}
            onChange={(e) => setUploadKind(e.target.value)}
            disabled={uploading}
          >
            {UPLOAD_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            className="auth-submit ast-upload-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '上传中...' : '上传图片'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files || []);
              e.target.value = '';
              handleUpload(list);
            }}
          />
        </div>

        {status && <div className="modal-msg ast-status">{status}</div>}

        {loading ? (
          <div className="modal-empty">加载中...</div>
        ) : assets.length === 0 ? (
          <div className="modal-empty">还没有图片资源，点上方「上传图片」添加</div>
        ) : (
          <div className="ast-grid">
            {assets.map((a) => (
              <div key={a.id} className="ast-cell asset-cell">
                <div className="ast-cell-thumb">
                  <img
                    src={resolveMediaUrl(a.url)}
                    alt={a.name || '资源'}
                    loading="lazy"
                  />
                </div>
                <div className="ast-cell-meta">
                  <div className="ast-cell-name" title={a.name}>
                    {a.name || '未命名'}
                  </div>
                  <div className="ast-cell-sub">
                    <span className="ast-tag">{sourceLabel(a.source)}</span>
                    <span>{KIND_LABEL[a.kind] || a.kind}</span>
                    <span>{formatSize(a.size)}</span>
                  </div>
                </div>
                <button
                  className="btn-danger-mini ast-cell-del"
                  onClick={() => handleDelete(a)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}