import { useEffect, useRef, useState } from 'react';
import {
  listStickerPacks,
  createStickerPack,
  getStickerPack,
  updateStickerPack,
  deleteStickerPack,
  uploadStickerItems,
  reorderStickerItems,
  removeStickerItem,
  shareStickerPack,
  setStickerPackPrivate,
  subscribeStickerPack,
  unsubscribeStickerPack
} from '../../api';
import { resolveMediaUrl } from '../../utils/media';
import { IMAGE_ACCEPT } from '../../utils/image';

// 单张表情「原图」上限：上传前会压到 2MB / 512px，这里只是拦住明显异常的巨图
const MAX_RAW_ITEM_SIZE = 40 * 1024 * 1024;
// 与服务端 assets.max_files_per_request / 面板提示保持一致
const MAX_FILES_PER_UPLOAD = 50;

/**
 * 表情包管理（整页）。
 *
 * [CHANGED] 认证改造：不再接收 token prop。
 */
export default function StickerPackManager({ onClose, onChanged }) {
  // 表情包列表
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(false);

  // 当前选中的表情包与详情
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 新建表情包
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // 改名 / 改简介
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [metaMsg, setMetaMsg] = useState('');

  // 上传
  const [uploading, setUploading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [uploadMsg, setUploadMsg] = useState('');

  // 分享
  const [copyMsg, setCopyMsg] = useState('');

  // 订阅
  const [code, setCode] = useState('');
  const [subscribeErr, setSubscribeErr] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  const fileRef = useRef(null);

  // Esc 关闭弹窗（与其它弹窗一致）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 打开某个表情包：拉取详情
  const openPack = async (id) => {
    if (!id) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(id);
    setDetailLoading(true);
    setUploadMsg('');
    setMetaMsg('');
    setCopyMsg('');
    try {
      const d = await getStickerPack(id);
      setDetail(d);
      setEditName(d?.pack?.name || '');
      setEditDesc(d?.pack?.description || '');
    } catch (err) {
      setDetail(null);
      alert(err.message || '操作失败');
    } finally {
      setDetailLoading(false);
    }
  };

  /** 重新拉列表；keepId 为空时优先保留当前选中，失效则落到第一个 */
  const refresh = async (keepId) => {
    setLoading(true);
    try {
      const d = await listStickerPacks();
      const list = d?.packs || [];
      setPacks(list);
      const want = keepId || selectedId;
      const exists = list.some((p) => p.id === want);
      await openPack(exists ? want : list[0]?.id ?? null);
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 新建表情包 ──────────────────────────────────
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      alert('请输入表情包名称');
      return;
    }
    setCreating(true);
    try {
      const res = await createStickerPack({
        name,
        description: newDesc.trim()
      });
      setNewName('');
      setNewDesc('');
      await refresh(res?.pack?.id ?? null);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setCreating(false);
    }
  };

  // ── 批量上传表情 ────────────────────────────────
  const handleUpload = async (fileList) => {
    let files = Array.from(fileList || []);
    const packId = detail?.pack?.id;
    if (!files.length || !packId) return;

    // 与面板提示 / 服务端上限保持一致：单次最多 50 张
    if (files.length > MAX_FILES_PER_UPLOAD) {
      alert(`单次最多上传 ${MAX_FILES_PER_UPLOAD} 张，已自动只取前 ${MAX_FILES_PER_UPLOAD} 张`);
      files = files.slice(0, MAX_FILES_PER_UPLOAD);
    }

    const tooBig = files.find((f) => f.size > MAX_RAW_ITEM_SIZE);
    if (tooBig) {
      alert(`「${tooBig.name}」超过 40MB，请先压缩后再上传`);
      return;
    }

    setPendingCount(files.length);
    setUploading(true);
    setUploadMsg('');
    try {
      const res = await uploadStickerItems(packId, files);
      // refresh 会清空提示，所以刷新后再写入结果
      await refresh(packId);
      setUploadMsg(
        `本次新增 ${res?.created ?? 0} 张，去重 ${res?.deduped ?? 0} 张`
      );
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setUploading(false);
    }
  };

  // ── 排序：与相邻项交换，再提交整个顺序 ──────────
  const moveItem = async (index, delta) => {
    const packId = detail?.pack?.id;
    const items = detail?.items || [];
    const target = index + delta;
    if (!packId || target < 0 || target >= items.length) return;

    const next = items.slice();
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    // 先本地交换，失败再回滚
    setDetail((prev) => (prev ? { ...prev, items: next } : prev));

    try {
      const res = await reorderStickerItems(
        packId,
        next.map((it) => it.id)
      );
      if (res?.items) {
        setDetail((prev) => (prev ? { ...prev, items: res.items } : prev));
      }
      onChanged?.();
    } catch (err) {
      setDetail((prev) => (prev ? { ...prev, items } : prev));
      alert(err.message || '操作失败');
    }
  };

  // ── 删除单个表情 ────────────────────────────────
  const handleRemoveItem = async (item) => {
    const packId = detail?.pack?.id;
    if (!packId) return;
    try {
      await removeStickerItem(packId, item.id);
      await refresh(packId);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  // ── 保存名称 / 简介 ─────────────────────────────
  const handleSaveMeta = async () => {
    const pack = detail?.pack;
    if (!pack) return;
    const name = editName.trim();
    if (!name) {
      alert('名称不能为空');
      return;
    }
    setSaving(true);
    setMetaMsg('');
    try {
      const res = await updateStickerPack(pack.id, {
        name,
        description: editDesc.trim()
      });
      const nextPack = res?.pack || { ...pack, name, description: editDesc.trim() };
      setDetail((prev) => (prev ? { ...prev, pack: nextPack } : prev));
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? { ...p, ...nextPack } : p)));
      setMetaMsg('已保存');
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    } finally {
      setSaving(false);
    }
  };

  // ── 分享 / 停止公开 / 复制分享码 ────────────────
  const handleShare = async (regenerate) => {
    const pack = detail?.pack;
    if (!pack) return;
    setCopyMsg('');
    try {
      const res = await shareStickerPack(pack.id, !!regenerate);
      setDetail((prev) =>
        prev
          ? { ...prev, pack: { ...prev.pack, isPublic: true, shareCode: res?.shareCode || null } }
          : prev
      );
      setPacks((prev) =>
        prev.map((p) =>
          p.id === pack.id ? { ...p, isPublic: true, shareCode: res?.shareCode || null } : p
        )
      );
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const handleSetPrivate = async () => {
    const pack = detail?.pack;
    if (!pack) return;
    setCopyMsg('');
    try {
      const res = await setStickerPackPrivate(pack.id);
      const nextPack = res?.pack || { ...pack, isPublic: false, shareCode: null };
      setDetail((prev) => (prev ? { ...prev, pack: nextPack } : prev));
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? { ...p, ...nextPack } : p)));
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg('已复制');
    } catch (err) {
      alert(err.message || '复制失败');
    }
  };

  // ── 删除整个表情包 ──────────────────────────────
  const handleDeletePack = async () => {
    const pack = detail?.pack;
    if (!pack) return;
    if (!confirm(`确定删除表情包「${pack.name}」？该操作不可恢复。`)) return;
    try {
      await deleteStickerPack(pack.id);
      await refresh(null);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  // ── 取消订阅 ────────────────────────────────────
  const handleUnsubscribe = async () => {
    const pack = detail?.pack;
    if (!pack) return;
    try {
      await unsubscribeStickerPack(pack.id);
      await refresh(null);
      onChanged?.();
    } catch (err) {
      alert(err.message || '操作失败');
    }
  };

  // ── 凭分享码订阅 ────────────────────────────────
  const handleSubscribe = async () => {
    const c = code.trim();
    setSubscribeErr('');
    if (!c) {
      setSubscribeErr('请输入分享码');
      return;
    }
    setSubscribing(true);
    try {
      const res = await subscribeStickerPack(c);
      setCode('');
      await refresh(res?.pack?.id ?? null);
      onChanged?.();
    } catch (err) {
      setSubscribeErr(err.message || '订阅失败');
    } finally {
      setSubscribing(false);
    }
  };

  const pack = detail?.pack || null;
  const items = detail?.items || [];

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-card stk-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">表情包管理</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="stk-panel">
          {/* ── 左列：表情包列表 + 订阅 ── */}
          <div className="stk-list">
            <div className="stk-list-scroll">
              <div className="stk-create">
                <input
                  className="auth-input"
                  value={newName}
                  maxLength={40}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="新建表情包名称"
                />
                <input
                  className="auth-input"
                  value={newDesc}
                  maxLength={200}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="简介（可选）"
                />
                <button
                  className="auth-submit stk-create-btn"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  {creating ? '创建中...' : '新建表情包'}
                </button>
              </div>

              {loading && <div className="modal-empty">加载中...</div>}
              {!loading && packs.length === 0 && (
                <div className="modal-empty">还没有表情包</div>
              )}

              {packs.map((p) => (
                <button
                  key={p.id}
                  className={`stk-list-item ${p.id === selectedId ? 'active' : ''}`}
                  onClick={() => openPack(p.id)}
                >
                  <span className="stk-list-thumb">
                    {p.coverUrl ? (
                      <img src={resolveMediaUrl(p.coverUrl)} alt="" />
                    ) : (
                      <span className="stk-list-thumb-text">
                        {(p.name || '?').slice(0, 1)}
                      </span>
                    )}
                  </span>
                  <span className="stk-list-main">
                    <span className="stk-list-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="stk-list-sub">{p.itemCount ?? 0} 张</span>
                    <span className="stk-list-badges">
                      <span
                        className={`stk-badge ${
                          p.isOwner ? 'stk-badge-own' : 'stk-badge-sub'
                        }`}
                      >
                        {p.isOwner ? '我的' : '订阅'}
                      </span>
                      {p.isPublic && p.shareCode && (
                        <span className="stk-badge stk-badge-public">
                          公开 {p.shareCode}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {/* 订阅表单：始终可见 */}
            <div className="stk-subscribe">
              <div className="stk-subscribe-row">
                <input
                  className="auth-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubscribe();
                  }}
                  placeholder="输入分享码"
                  disabled={subscribing}
                />
                <button
                  className="auth-submit stk-subscribe-btn"
                  onClick={handleSubscribe}
                  disabled={subscribing}
                >
                  {subscribing ? '...' : '订阅'}
                </button>
              </div>
              {subscribeErr && <div className="auth-error">{subscribeErr}</div>}
            </div>
          </div>

          {/* ── 右列：详情 ── */}
          <div className="stk-detail">
            {detailLoading && <div className="modal-empty">加载中...</div>}
            {!detailLoading && !pack && (
              <div className="modal-empty">选择左侧的表情包查看详情</div>
            )}

            {!detailLoading && pack && (
              <>
                <div className="stk-detail-head">
                  <span className="stk-detail-title">{pack.name}</span>
                  <span className="stk-detail-sub">
                    {items.length} 张
                    {pack.isOwner ? ' · 我创建的' : ' · 已订阅'}
                    {pack.subscriberCount ? ` · ${pack.subscriberCount} 人订阅` : ''}
                  </span>
                </div>
                {pack.description && (
                  <div className="stk-detail-desc">{pack.description}</div>
                )}

                {pack.isOwner ? (
                  <>
                    {/* 改名 / 简介 */}
                    <div className="stk-edit-row">
                      <input
                        className="auth-input"
                        value={editName}
                        maxLength={40}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="表情包名称"
                      />
                      <input
                        className="auth-input"
                        value={editDesc}
                        maxLength={200}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="简介（可选）"
                      />
                      <button
                        className="btn-secondary stk-mini"
                        onClick={handleSaveMeta}
                        disabled={saving}
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </div>
                    {metaMsg && <div className="modal-msg stk-msg">{metaMsg}</div>}

                    {/* 分享码 */}
                    {pack.isPublic && pack.shareCode ? (
                      <div className="stk-share-row">
                        <input
                          className="auth-input"
                          readOnly
                          value={pack.shareCode}
                          onFocus={(e) => e.target.select()}
                        />
                        <button
                          className="btn-secondary stk-mini"
                          onClick={() => handleCopy(pack.shareCode)}
                        >
                          复制
                        </button>
                        <button
                          className="btn-secondary stk-mini"
                          onClick={() => handleShare(true)}
                        >
                          重新生成
                        </button>
                        <button
                          className="btn-secondary stk-mini"
                          onClick={handleSetPrivate}
                        >
                          停止公开
                        </button>
                        {copyMsg && <span className="stk-hint">{copyMsg}</span>}
                      </div>
                    ) : (
                      <div className="stk-share-row">
                        <button
                          className="btn-secondary stk-mini"
                          onClick={() => handleShare(false)}
                        >
                          生成分享码
                        </button>
                        <span className="stk-hint">
                          生成后别人可用分享码订阅这个表情包
                        </span>
                      </div>
                    )}

                    {/* 上传 */}
                    <div className="stk-toolbar">
                      <button
                        className="btn-secondary stk-mini"
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading}
                      >
                        {uploading ? '上传中...' : '上传表情'}
                      </button>
                      <span className="stk-hint">
                        当前 {items.length} 张
                        {pendingCount > 0 ? ` · 本次已选 ${pendingCount} 个文件` : ''}
                        {' · '}单次最多 50 张 · 大图自动压缩
                      </span>
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
                    {uploadMsg && <div className="modal-msg stk-msg">{uploadMsg}</div>}

                    {/* 表情网格 */}
                    {items.length === 0 ? (
                      <div className="modal-empty">还没有表情，点上方「上传表情」添加</div>
                    ) : (
                      <div className="stk-grid">
                        {items.map((item, idx) => (
                          <div key={item.id} className="stk-cell">
                            <img
                              className="stk-cell-img sticker-cell"
                              src={resolveMediaUrl(item.url)}
                              alt={item.name || '表情'}
                              loading="lazy"
                            />
                            <div className="stk-cell-tools">
                              <button
                                className="stk-cell-btn"
                                title="上移"
                                onClick={() => moveItem(idx, -1)}
                                disabled={idx === 0}
                              >
                                ↑
                              </button>
                              <button
                                className="stk-cell-btn"
                                title="下移"
                                onClick={() => moveItem(idx, 1)}
                                disabled={idx === items.length - 1}
                              >
                                ↓
                              </button>
                              <button
                                className="stk-cell-btn stk-cell-del"
                                title="删除"
                                onClick={() => handleRemoveItem(item)}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="modal-actions stk-actions">
                      <button
                        className="btn-danger-mini stk-danger"
                        onClick={handleDeletePack}
                      >
                        删除表情包
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* 订阅者：只读 */}
                    {items.length === 0 ? (
                      <div className="modal-empty">这个表情包还没有表情</div>
                    ) : (
                      <div className="stk-grid">
                        {items.map((item) => (
                          <div key={item.id} className="stk-cell">
                            <img
                              className="stk-cell-img sticker-cell"
                              src={resolveMediaUrl(item.url)}
                              alt={item.name || '表情'}
                              loading="lazy"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="modal-actions">
                      <button className="btn-secondary" onClick={handleUnsubscribe}>
                        取消订阅
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}