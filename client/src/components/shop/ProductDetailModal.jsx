// client/src/components/shop/ProductDetailModal.jsx
//
// 【本次改动】
//   · 表情包商品（category=sticker_pack）：
//     - 只显示封面，不显示图集/缩略图（防止单张预览）
//     - 文件列表只显示数量与"购买后加入表情库"，不给预览 / 下载按钮
//     - 购买成功后提示"已加入表情库"，并给出跳转入口
//   · 图集里的图片改走 ProtectedImage（防顺手另存）
//
// 【本次修复】selectMedia 的 finally 会把 catch 刚写好的错误消息清掉
//   （同函数里 catch 里 setMediaNote(err.message)，finally 里立即
//     setMediaNote('')），导致视频加载失败时用户看到的是空白，而不是
//   失败原因。改法：把清空挪到 try 成功路径末尾，不再用 finally。
//
// [CHANGED] 认证改造：不再接收 token prop。getProduct / buyProduct /
//   downloadFile / previewFileBlob / adminDelistProduct 均由 http.js 从
//   auth/session.js 内存里读 Access。
//
import { useEffect, useRef, useState } from 'react';
import Avatar from '../common/Avatar';
import FileTypeIcon from '../common/FileTypeIcon';
import { fileKind } from '../../utils/fileTypes';
import MediaPreviewModal from '../common/MediaPreviewModal';
import ProtectedImage from '../common/ProtectedImage';
import {
  getProduct,
  buyProduct,
  downloadFile,
  previewFileBlob,
  adminDelistProduct
} from '../../api';
import { formatSize } from '../../utils/fileUtils';
import { resolveMediaUrl, formatTranscodeProgress } from '../../utils/media';

// 能在线预览的类型（其余只能下载）—— 与 MediaPreviewModal 支持的渲染方式一致
const PREVIEW_KIND = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  pdf: 'pdf',
  text: 'text',
  code: 'text'
};

// 文本预览上限：避免把几百 MB 的日志/JSON 读进内存把页面卡死
const TEXT_PREVIEW_MAX = 200 * 1024;

/**
 * 详情页「图集」：封面 + 卖家勾了「预览」的图片 / 视频。
 *
 * 复用 `product_files.is_preview` 标记，服务端 /api/shop/preview 也只放行这些文件。
 * 卖家把图片、视频当商品文件传上来并勾选预览，详情页就自动长成京东那种图集。
 */
function buildGallery(product, files) {
  const items = [];
  if (product?.coverUrl) {
    items.push({ key: 'cover', kind: 'image', src: resolveMediaUrl(product.coverUrl), name: '封面' });
  }
  for (const f of files || []) {
    if (!f.isPreview) continue;
    if (f.locked) continue; // 表情包商品：文件全部锁住
    const k = fileKind(f.name, f.type).key;
    if (k === 'image' || k === 'video') {
      items.push({ key: `f${f.id}`, kind: k, file: f, name: f.name });
    }
  }
  return items;
}

export default function ProductDetailModal({
  productId,
  can,
  onClose,
  onBought,
  onDelisted
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 图集：媒体 Blob 的 objectURL（按 fileId 索引）与当前选中项
  const [mediaUrls, setMediaUrls] = useState({});
  const [mediaIndex, setMediaIndex] = useState(0);
  const [mediaNote, setMediaNote] = useState('');
  const [preview, setPreview] = useState(null);
  const urlsRef = useRef([]);

  useEffect(() => () => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    getProduct(productId)
      .then(async (d) => {
        if (!alive) return;
        setData(d);
        // 图集里的图片：shop 目录未静态暴露，必须带鉴权取 Blob 再转 URL。
        // 视频不在这里预取（可能很大），等用户点中它再加载。
        const items = buildGallery(d.product, d.files);
        const map = {};
        for (const it of items) {
          if (it.kind !== 'image' || !it.file) continue;
          try {
            const blob = await previewFileBlob(productId, it.file.id);
            if (!alive) return;
            const url = URL.createObjectURL(blob);
            urlsRef.current.push(url);
            map[it.file.id] = url;
          } catch {
            /* 单张预览图取不到不影响整页 */
          }
        }
        if (alive) setMediaUrls(map);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [productId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !preview) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, preview]);

  const handleBuy = async () => {
    if (!confirm('确认用积分购买？')) return;
    setBusy(true);
    try {
      const res = await buyProduct(productId);
      if (res?.grantedPackId) {
        alert('购买成功：表情包已加入你的表情库，聊天界面可直接使用');
      } else {
        alert('购买成功');
      }
      onBought?.(res);
      onClose();
    } catch (err) {
      alert(err.message || '购买失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDelist = async () => {
    const reason = prompt('下架原因：');
    if (reason === null) return;
    setBusy(true);
    try {
      await adminDelistProduct(productId, reason || '管理员下架');
      alert('已下架');
      onDelisted?.();
      onClose();
    } catch (err) {
      alert(err.message || '下架失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (file) => {
    setBusy(true);
    try {
      const blob = await downloadFile(productId, file.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(err.message || '下载失败');
    } finally {
      setBusy(false);
    }
  };

  const p = data?.product;
  const files = data?.files || [];
  const isSelf = data?.isSeller;
  const bought = data?.bought;
  const isStickerPack = p?.category === 'sticker_pack';
  // 表情包商品不给下载入口
  const canDownload = (isSelf || bought || can('delist_product')) && !isStickerPack;
  const canBuy = p?.status === 'on_sale' && !isSelf && !bought;

  // 表情包商品不出图集（只显示封面）
  const gallery = isStickerPack ? [] : buildGallery(p, files);
  const current = gallery[Math.min(mediaIndex, gallery.length - 1)] || null;
  const currentUrl = current?.file ? mediaUrls[current.file.id] : current?.src;

  /**
   * 取「播得了的那份」视频。服务端 ?playback=1：
   *   200 → 原件本来就能播，或转码副本已就绪；
   *   202 → 还在转码（本地 ffmpeg），等几秒再问，并把进度显示出来；
   *   409 → 转码失败（or 副本丢了），把原因抛给调用方展示。
   */
  const fetchPlayableBlob = async (file, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      try {
        return await previewFileBlob(productId, file.id, { playback: true });
      } catch (err) {
        if (err.status !== 202) throw err;
        const pct = formatTranscodeProgress(err.data?.progress);
        setMediaNote(`源格式浏览器播不了，服务器正在转码${pct ? ` ${pct}` : ''}…`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    throw new Error('转码时间过长，请稍后再试或直接下载');
  };

  const selectMedia = async (i) => {
    setMediaIndex(i);
    const it = gallery[i];
    if (!it || it.kind !== 'video' || !it.file || mediaUrls[it.file.id]) return;
    setMediaNote('');
    try {
      const blob = await fetchPlayableBlob(it.file);
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setMediaUrls((m) => ({ ...m, [it.file.id]: url }));
      // [FIX] 成功后再清空提示。原来放在 finally 里会在 catch 刚写好
      //   错误消息（setMediaNote(err.message)）之后立即把它清掉，
      //   视频加载失败时用户看到的是空白。
      setMediaNote('');
    } catch (err) {
      setMediaNote(err.message || '视频加载失败');
    }
  };

  /** 试看：登录即可，不需要购买（服务端只放行 is_preview 的文件） */
  const openPreview = async (file) => {
    const kind = PREVIEW_KIND[fileKind(file.name, file.type).key];
    setPreview({ title: file.name, kind, loading: true });
    try {
      const blob = (kind === 'video' || kind === 'audio')
        ? await fetchPlayableBlob(file)
        : await previewFileBlob(productId, file.id);
      if (kind === 'text') {
        const full = await blob.text();
        setPreview({
          title: file.name,
          kind,
          text: full.slice(0, TEXT_PREVIEW_MAX),
          truncated: full.length > TEXT_PREVIEW_MAX,
          loading: false
        });
        return;
      }
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setPreview({ title: file.name, kind, url, loading: false });
    } catch (err) {
      setPreview({ title: file.name, kind, error: err.message, loading: false });
    } finally {
      setMediaNote('');
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 540 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">商品详情</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading && <div className="modal-empty">加载中...</div>}
        {error && <div className="auth-error">{error}</div>}

        {p && (
          <>
            {/* ---------- 图集 ---------- */}
            {isStickerPack ? (
              // 表情包：只显示封面（防止通过"单张预览"绕过商品购买流程）
              <div className="detail-cover">
                {p.coverUrl ? (
                  <ProtectedImage
                    src={resolveMediaUrl(p.coverUrl)}
                    alt={p.title}
                  />
                ) : (
                  <div className="product-cover-placeholder big">
                    {p.title.slice(0, 1)}
                  </div>
                )}
              </div>
            ) : gallery.length > 0 ? (
              <div className="pd-gallery">
                <div className="pd-stage">
                  {current?.kind === 'image' && currentUrl && (
                    <ProtectedImage src={currentUrl} alt={current.name} />
                  )}
                  {current?.kind === 'image' && !currentUrl && (
                    <div className="pd-stage-state">图片加载中…</div>
                  )}
                  {current?.kind === 'video' && currentUrl && (
                    <video
                      src={currentUrl}
                      controls
                      preload="metadata"
                      playsInline
                      onContextMenu={(e) => e.preventDefault()}
                    />
                  )}
                  {current?.kind === 'video' && !currentUrl && (
                    <div className="pd-stage-state">
                      <FileTypeIcon name={current.name} mime="video" size={54} />
                      <span>{mediaNote || '视频将在选中后加载'}</span>
                    </div>
                  )}
                </div>
                {gallery.length > 1 && (
                  <div className="pd-thumbs">
                    {gallery.map((it, i) => (
                      <button
                        key={it.key}
                        type="button"
                        className={`pd-thumb ${i === mediaIndex ? 'active' : ''}`}
                        onClick={() => selectMedia(i)}
                        title={it.name}
                      >
                        {it.kind === 'image' && (it.file ? mediaUrls[it.file.id] : it.src) ? (
                          <ProtectedImage
                            src={it.file ? mediaUrls[it.file.id] : it.src}
                            alt={it.name}
                          />
                        ) : (
                          <FileTypeIcon name={it.name} mime={it.kind} size={30} />
                        )}
                        {it.kind === 'video' && <span className="pd-thumb-play" aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="detail-cover">
                <div className="product-cover-placeholder big">
                  {p.title.slice(0, 1)}
                </div>
              </div>
            )}

            <h3 className="detail-title">{p.title}</h3>
            <div className="detail-market">
              {marketLabel(p.market)} · {categoryLabel(p.category)} · {statusLabel(p.status)}
            </div>

            <div className="detail-seller">
              <Avatar name={p.sellerName} avatar={p.sellerAvatar} size={28} />
              <span>{p.sellerName}</span>
            </div>

            {p.description && <div className="detail-desc">{p.description}</div>}

            {/* ---------- 文件列表 ---------- */}
            <div className="detail-files">
              <div className="detail-files-title">
                {isStickerPack
                  ? `表情数量：${files.length}`
                  : `文件列表（${files.length}）`}
              </div>

              {isStickerPack ? (
                // 表情包：只有一行说明，不给任何单张预览/下载入口
                <div className="detail-file-row">
                  <span className="detail-file-icon" aria-hidden="true">
                    <FileTypeIcon name="sticker.png" mime="image/png" size={34} />
                  </span>
                  <div className="detail-file-info">
                    <div className="detail-file-name">
                      购买后整包加入你的表情库
                    </div>
                    <div className="detail-file-meta">
                      聊天界面可直接使用 · 不提供文件下载
                    </div>
                  </div>
                </div>
              ) : (
                files.map((f) => (
                  <div key={f.id} className="detail-file-row">
                    <span className="detail-file-icon" aria-hidden="true">
                      <FileTypeIcon name={f.name} mime={f.type} size={34} />
                    </span>
                    <div className="detail-file-info">
                      <div className="detail-file-name" title={f.name}>
                        {f.name}
                      </div>
                      <div className="detail-file-meta">
                        {f.type || '文件'} · {formatSize(f.size)}
                      </div>
                    </div>
                    <div className="detail-file-action">
                      {f.isPreview && (
                        <button
                          className="mini-btn"
                          onClick={() => openPreview(f)}
                          disabled={busy}
                        >
                          预览
                        </button>
                      )}
                      {canDownload ? (
                        <button
                          className="mini-btn ok"
                          onClick={() => handleDownload(f)}
                          disabled={busy}
                        >
                          下载
                        </button>
                      ) : (
                        <span className="detail-file-locked" title="购买后可下载">
                          未购买
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="detail-price">
              {p.status === 'pending_review'
                ? '待开发者定价'
                : (p.price > 0 ? `${p.price} 积分` : '免费')}
            </div>

            <div className="modal-actions">
              {canBuy && (
                <button className="auth-submit" onClick={handleBuy} disabled={busy}>
                  {busy
                    ? '处理中...'
                    : (isStickerPack ? '购买（加入表情库）' : '购买')}
                </button>
              )}
              {bought && (
                <div className="detail-bought">
                  {isStickerPack
                    ? '已购买 · 可在「表情包」里使用'
                    : '已购买'}
                </div>
              )}
              {isSelf && <div className="detail-bought">这是你发布的商品</div>}
              {can('delist_product') && p.status === 'on_sale' && (
                <button
                  className="btn-secondary"
                  style={{ color: '#e74c3c', borderColor: '#f5b7b1' }}
                  onClick={handleDelist}
                  disabled={busy}
                >
                  下架
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {preview && (
        <MediaPreviewModal
          title={preview.title}
          kind={preview.kind}
          url={preview.url}
          text={preview.text}
          truncated={preview.truncated}
          loading={preview.loading}
          note={mediaNote}
          error={preview.error}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function marketLabel(m) {
  return { official: '官方市场', standard: '标准市场', flea: '跳蚤市场' }[m] || m;
}

function categoryLabel(c) {
  return {
    goods: '普通商品',
    background: '聊天背景',
    bubble: '气泡主题',
    sticker_pack: '表情包'
  }[c] || '普通商品';
}

function statusLabel(s) {
  return {
    on_sale: '在售',
    pending_review: '待审核',
    sold: '已售出',
    delisted: '已下架',
    pirated: '盗版下架',
    hidden: '已隐藏'
  }[s] || s;
}