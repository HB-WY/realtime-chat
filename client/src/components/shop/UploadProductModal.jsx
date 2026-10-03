import { useEffect, useRef, useState } from 'react';
import {
  uploadShopFile,
  uploadShopCover,
  createProduct
} from '../../api';
import { formatSize } from '../../utils/fileUtils';

const MARKETS = [
  { key: 'flea', label: '跳蚤市场', tip: '自己定价，直接上架' },
  { key: 'standard', label: '标准市场', tip: '提交后由开发者评估定价' },
  { key: 'official', label: '官方市场', tip: '官方自营，仅管理员及以上' }
];

const MAX_FILES = 20;

// 商品分类：goods = 普通商品；其余为外观素材。
// 外观素材与普通商品规则完全一致（同样防抄袭、同样定价审核 / 下架），
// 区别只在购买后会复制进买家资源库、可直接使用。
const CATEGORIES = [
  { key: 'goods', label: '普通商品', tip: '文件 / 资料等' },
  { key: 'background', label: '聊天背景', tip: '图片素材，购买后可直接用作背景' },
  { key: 'bubble', label: '气泡主题', tip: '图片 +（可选）theme.json 配置' },
  { key: 'sticker_pack', label: '表情包', tip: '一整套表情图片' }
];

/**
 * 上架商品弹窗。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function UploadProductModal({ can, onClose, onCreated }) {
  const [market, setMarket] = useState('flea');
  const [category, setCategory] = useState('goods');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');

  const [cover, setCover] = useState(null);
  const [coverUploading, setCoverUploading] = useState(false);

  const [files, setFiles] = useState([]);
  const [fileUploading, setFileUploading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const coverRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const handleCover = async (f) => {
    if (!f) return;
    setError('');
    setCoverUploading(true);
    try {
      const res = await uploadShopCover(f);
      setCover(res);
    } catch (err) {
      setError(err.message || '封面上传失败');
    } finally {
      setCoverUploading(false);
    }
  };

  const handleFiles = async (fileList) => {
    const arr = Array.from(fileList);
    if (!arr.length) return;

    const remain = MAX_FILES - files.length;
    if (remain <= 0) {
      setError(`最多 ${MAX_FILES} 个文件`);
      return;
    }
    const batch = arr.slice(0, remain);

    setError('');
    setFileUploading(true);
    try {
      const uploaded = [];
      for (const f of batch) {
        const res = await uploadShopFile(f);
        uploaded.push({
          url: res.url,
          name: res.name,
          size: res.size,
          mime: res.mime,
          isPreview: false
        });
      }
      setFiles((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setError(err.message || '文件上传失败');
    } finally {
      setFileUploading(false);
    }
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const togglePreview = (idx) => {
    setFiles((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, isPreview: !f.isPreview } : f))
    );
  };

  const submit = async () => {
    setError('');
    if (!title.trim() || title.trim().length < 2) {
      setError('标题至少 2 个字符');
      return;
    }
    if (files.length === 0) {
      setError('至少上传一个文件');
      return;
    }
    if (market !== 'standard') {
      const n = Number(price === '' ? 0 : price);
      if (!Number.isInteger(n) || n < 0 || n > 100000) {
        setError('价格需为 0-100000 的整数（0 = 免费商品）');
        return;
      }
    }
    if (category !== 'goods') {
      const hasImage = files.some(
        (f) => (f.mime || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name || '')
      );
      if (!hasImage) {
        setError('外观素材商品至少需要一张图片文件');
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await createProduct({
        market,
        category,
        title: title.trim(),
        description: description.trim(),
        price: market === 'standard' ? 0 : Number(price === '' ? 0 : price),
        coverUrl: cover?.url || null,
        files: files.map((f) => ({
          url: f.url,
          name: f.name,
          type: f.mime?.startsWith('image/') ? 'image' : 'file',
          size: f.size,
          isPreview: f.isPreview
        }))
      });
      alert(res.message || '已提交');
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err.message || '上架失败');
    } finally {
      setSubmitting(false);
    }
  };

  const needPrice = market !== 'standard';
  const busy = coverUploading || fileUploading || submitting;

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal-card"
        style={{ maxWidth: 540 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">上架商品</span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        <label className="modal-label">选择市场</label>
        <div className="market-picker">
          {MARKETS.map((m) => {
            // [CHANGED] 官方市场是官方自营：按 official_publish 能力门禁，
            // 普通用户看不到该选项（服务端同样拦截，双保险）。
            const gated = m.key === 'official' && can && !can('official_publish');
            return (
              <button
                key={m.key}
                type="button"
                className={`market-choice ${market === m.key ? 'active' : ''}`}
                onClick={() => setMarket(m.key)}
                disabled={busy || gated}
                title={gated ? '官方市场仅对管理员及以上开放' : undefined}
              >
                <div className="market-choice-name">{m.label}</div>
                <div className="market-choice-tip">
                  {gated ? '官方自营，无权限' : m.tip}
                </div>
              </button>
            );
          })}
        </div>

        <label className="modal-label">商品分类</label>
        <div className="market-picker">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`market-choice ${category === c.key ? 'active' : ''}`}
              onClick={() => setCategory(c.key)}
              disabled={busy}
            >
              <div className="market-choice-name">{c.label}</div>
              <div className="market-choice-tip">{c.tip}</div>
            </button>
          ))}
        </div>

        <label className="modal-label">商品标题</label>
        <input
          className="auth-input"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="2-80 字符"
          disabled={busy}
        />

        <label className="modal-label">描述（可选，参与防抄袭检测）</label>
        <textarea
          className="auth-input"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="简要描述商品内容..."
          disabled={busy}
          style={{ resize: 'vertical', minHeight: 70 }}
        />

        {needPrice && (
          <>
            <label className="modal-label">
              {market === 'official' ? '官方定价（积分）' : '你的定价（积分，0 = 免费）'}
            </label>
            <input
              className="auth-input"
              type="number"
              min={0}
              max={100000}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0-100000，0 表示免费"
              disabled={busy}
            />
          </>
        )}

        <label className="modal-label">封面（可选）</label>
        <div className="cover-upload">
          {cover ? (
            <div className="cover-preview">
              <img src={cover.url} alt="封面" />
              <button
                className="cover-remove"
                onClick={() => setCover(null)}
                disabled={busy}
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="cover-placeholder"
              onClick={() => coverRef.current?.click()}
              disabled={busy}
            >
              {coverUploading ? '上传中...' : '+ 上传封面'}
            </button>
          )}
          <input
            ref={coverRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              handleCover(f);
            }}
          />
        </div>

        <label className="modal-label">
          商品文件（最多 {MAX_FILES} 个）
        </label>
        <div className="files-upload">
          <button
            className="btn-secondary"
            onClick={() => fileRef.current?.click()}
            disabled={busy || files.length >= MAX_FILES}
            style={{ flex: 'none', padding: '8px 16px' }}
          >
            {fileUploading ? '上传中...' : '+ 添加文件'}
          </button>
          <span className="files-count">
            {files.length} / {MAX_FILES}
          </span>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {files.length > 0 && (
          <div className="files-list">
            {files.map((f, i) => (
              <div key={i} className="files-item">
                <div className="files-item-name" title={f.name}>
                  {f.name}
                </div>
                <div className="files-item-size">{formatSize(f.size)}</div>
                <label className="files-item-preview">
                  <input
                    type="checkbox"
                    checked={f.isPreview}
                    onChange={() => togglePreview(i)}
                    disabled={busy}
                  />
                  预览
                </label>
                <button
                  className="files-item-remove"
                  onClick={() => removeFile(i)}
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="auth-submit" onClick={submit} disabled={busy}>
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      </div>
    </div>
  );
}