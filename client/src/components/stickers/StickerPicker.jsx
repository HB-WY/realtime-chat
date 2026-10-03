// client/src/components/stickers/StickerPicker.jsx
//
// 聊天输入区的表情包面板。
//
// 【本次改动】onPick 携带 packId：
//   发送出去的消息会带 stickerPackId，聊天里右键表情时能反查到
//   "这个表情来自哪个包 / 我是否拥有"，据此决定是否显示购买入口。
//
// [CHANGED] 认证改造：不再接收 token prop。
//
import { useEffect, useRef, useState } from 'react';
import { listStickerPacks, getStickerPack } from '../../api';
import { resolveMediaUrl } from '../../utils/media';

export default function StickerPicker({ onPick, onClose, onManage, revision = 0 }) {
  const ref = useRef(null);
  const [packs, setPacks] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // 点击面板外部 / Esc 关闭
  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      // 忽略触发开关的那个按钮，否则会出现"关不掉"的鬼畜
      if (e.target.closest && e.target.closest('.sticker-btn')) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 表情包列表
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await listStickerPacks();
        if (!alive) return;
        const list = d.packs || [];
        setPacks(list);
        setActiveId(list[0]?.id ?? null);
      } catch {
        if (alive) setPacks([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [revision]);

  // 选中包的内容
  useEffect(() => {
    if (!activeId) { setItems([]); return; }
    let alive = true;
    (async () => {
      try {
        const d = await getStickerPack(activeId);
        if (alive) setItems(d.items || []);
      } catch {
        if (alive) setItems([]);
      }
    })();
    return () => { alive = false; };
  }, [activeId, revision]);

  return (
    <div ref={ref} className="sticker-picker">
      <div className="sticker-picker-head">
        <span className="sticker-picker-title">表情包</span>
        {onManage && (
          <button className="sticker-manage-btn" onClick={onManage}>
            管理
          </button>
        )}
      </div>

      {loading ? (
        <div className="modal-empty">加载中...</div>
      ) : packs.length === 0 ? (
        <div className="sticker-empty">
          还没有表情包
          {onManage && (
            <button className="sticker-manage-btn" onClick={onManage}>
              去创建 / 订阅
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="sticker-pack-tabs">
            {packs.map((p) => (
              <button
                key={p.id}
                className={`sticker-pack-tab ${activeId === p.id ? 'active' : ''}`}
                onClick={() => setActiveId(p.id)}
                title={`${p.name} · ${p.itemCount} 个`}
              >
                {p.name}
                {!p.isOwner && <span className="sticker-pack-sub">订阅</span>}
              </button>
            ))}
          </div>

          {items.length === 0 ? (
            <div className="modal-empty">这个表情包还没有表情</div>
          ) : (
            <div className="sticker-grid">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className="sticker-item"
                  title={it.name}
                  // [NEW] onPick 带上 packId（用于消息里记录所属表情包）
                  onClick={() => onPick({
                    url: it.url,
                    name: it.name || '表情',
                    packId: activeId
                  })}
                >
                  <img src={resolveMediaUrl(it.url)} alt={it.name} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}