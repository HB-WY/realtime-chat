import { useEffect, useState, useCallback } from 'react';
import {
  listMarket,
  listMine,
  listOrders,
  adminDelistProduct,
  adminHideProduct,
  downloadFile
} from '../../api';
import ProductCard from './ProductCard';
import ProductDetailModal from './ProductDetailModal';
import UploadProductModal from './UploadProductModal';

const MARKETS = [
  { key: 'official', label: '官方市场', desc: '官方自营，品质保证' },
  { key: 'standard', label: '标准市场', desc: '开发者审核定价' },
  { key: 'flea', label: '跳蚤市场', desc: '用户自主上架' }
];

// 商品分类：普通商品 + 三类外观素材（规则完全一致，无豁免）
const CATEGORIES = [
  { key: '', label: '全部' },
  { key: 'goods', label: '普通商品' },
  { key: 'background', label: '聊天背景' },
  { key: 'bubble', label: '气泡主题' },
  { key: 'sticker_pack', label: '表情包' }
];

// [FIX B2] 移除死 prop `me`：组件内部从不使用，传给 ProductDetailModal
//   也无人接收（那边只解构 token / productId / can / onClose / onBought /
//   onDelisted）。调用方（ChatRoom）也一并去掉了传参。
//
// [CHANGED] 认证改造：不再接收 token prop。所有 API 调用由 http.js 从
//   auth/session.js 内存里读 Access。
export default function ShopPage({ can, onPointsChanged, initialTab, initialCategory }) {
  const [tab, setTab] = useState(initialTab || 'official');
  const [category, setCategory] = useState(initialCategory || '');
  const [products, setProducts] = useState([]);
  const [myProducts, setMyProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [keyword, setKeyword] = useState('');
  // 防抖后的关键词：输入框只改 keyword，真正发请求用 query。
  // 否则每敲一个字都会打一次接口，而且响应乱序时会用旧关键词的结果覆盖新的。
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      if (tab === 'mine') {
        const d = await listMine();
        setMyProducts(d.products || []);
      } else if (tab === 'orders') {
        const d = await listOrders();
        setOrders(d.orders || []);
      } else {
        const d = await listMarket(tab, query, category);
        setProducts(d.products || []);
      }
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tab, query, category]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelist = async (id) => {
    const reason = prompt('下架原因：');
    if (reason === null) return;
    try {
      await adminDelistProduct(id, reason || '管理员下架');
      alert('已下架');
      load();
    } catch (err) {
      alert(err.message || '下架失败');
    }
  };

  const handleHide = async (id) => {
    const reason = prompt('隐藏原因：');
    if (reason === null) return;
    try {
      await adminHideProduct(id, reason || '待审核');
      alert('已隐藏');
      load();
    } catch (err) {
      alert(err.message || '隐藏失败');
    }
  };

  // 商品文件必须走鉴权下载接口（/uploads/shop 不对外暴露），
  // 所以这里不能直接用 <a href>，要取 blob 再触发本地下载。
  const handleOrderDownload = async (o) => {
    if (!o.fileId) return;
    setBusyOrderId(o.id);
    setError('');
    try {
      const blob = await downloadFile(o.productId, o.fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = o.fileName || o.title || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err.message || '下载失败');
    } finally {
      setBusyOrderId(null);
    }
  };

  const isMarketTab = ['official', 'standard', 'flea'].includes(tab);

  return (
    <div className="shop-page">
      <div className="shop-header">
        <div className="shop-tabs">
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className={`shop-tab ${tab === m.key ? 'active' : ''}`}
              onClick={() => {
                setTab(m.key);
                setKeyword('');
                setQuery('');
              }}
              title={m.desc}
            >
              {m.label}
            </button>
          ))}
          <button
            className={`shop-tab ${tab === 'mine' ? 'active' : ''}`}
            onClick={() => setTab('mine')}
          >
            我发布的
          </button>
          <button
            className={`shop-tab ${tab === 'orders' ? 'active' : ''}`}
            onClick={() => setTab('orders')}
          >
            我购买的
          </button>
        </div>

        <div className="shop-actions">
          {isMarketTab && (
            <input
              className="shop-search"
              placeholder="搜索商品..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                // 回车立即搜索，不等防抖
                if (e.key === 'Enter') setQuery(keyword.trim());
              }}
            />
          )}
          {/* [CHANGED] 上架入口对所有登录用户开放（跳蚤 / 标准市场）。
              官方市场选项在弹窗内部按 official_publish 能力门禁。 */}
          <button
            className="auth-submit"
            style={{ width: 'auto', padding: '8px 20px' }}
            onClick={() => setUploadOpen(true)}
          >
            + 上架商品
          </button>
        </div>
      </div>

      {isMarketTab && (
        <div className="shop-categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.key || 'all'}
              className={`shop-cat ${category === c.key ? 'active' : ''}`}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="auth-error" style={{ margin: '0 24px' }}>
          {error}
        </div>
      )}

      <div className="shop-body">
        {loading && <div className="modal-empty">加载中...</div>}

        {!loading && isMarketTab && products.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">暂无商品</div>
            <div className="empty-desc">换个关键词试试，或去其他市场看看</div>
          </div>
        )}

        {!loading && isMarketTab && products.length > 0 && (
          <div className="product-grid">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onClick={() => setDetailId(p.id)}
                canManage={can('delist_product')}
                canHide={can('hide_product')}
                onDelist={() => handleDelist(p.id)}
                onHide={() => handleHide(p.id)}
              />
            ))}
          </div>
        )}

        {!loading && tab === 'mine' && (
          <div className="list-table">
            {myProducts.length === 0 && (
              <div className="modal-empty">还没发布过商品</div>
            )}
            {myProducts.map((p) => (
              <div key={p.id} className="list-row">
                <div className="list-main">
                  <div className="list-title">{p.title}</div>
                  <div className="list-sub">
                    {marketLabel(p.market)} · {categoryLabel(p.category)} · {statusLabel(p.status)}
                    {p.price > 0 && ` · ${p.price} 积分`}
                  </div>
                  {p.delistReason && (
                    <div className="list-warn">{p.delistReason}</div>
                  )}
                </div>
                <div className="list-actions">
                  <button
                    className="btn-secondary"
                    style={{ flex: 'none', padding: '4px 12px', fontSize: 12 }}
                    onClick={() => setDetailId(p.id)}
                  >
                    查看
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === 'orders' && (
          <div className="list-table">
            {orders.length === 0 && (
              <div className="modal-empty">还没购买过商品</div>
            )}
            {orders.map((o) => (
              <div key={o.id} className="list-row">
                <div className="list-main">
                  <div className="list-title">{o.title}</div>
                  <div className="list-sub">
                    {marketLabel(o.market)} · 卖家 {o.sellerName} · {o.price} 积分
                  </div>
                </div>
                {o.fileId ? (
                  <div className="list-actions">
                    <button
                      className="btn-secondary"
                      style={{ flex: 'none', padding: '4px 12px', fontSize: 12 }}
                      onClick={() => handleOrderDownload(o)}
                      disabled={busyOrderId === o.id}
                      title={o.fileCount > 1 ? '下载第一个文件，全部文件可在商品详情查看' : undefined}
                    >
                      {busyOrderId === o.id
                        ? '下载中...'
                        : o.fileCount > 1
                          ? `下载 (${o.fileCount})`
                          : '下载'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {detailId && (
        <ProductDetailModal
          productId={detailId}
          can={can}
          onClose={() => setDetailId(null)}
          onBought={() => {
            onPointsChanged?.();
            load();
          }}
          onDelisted={load}
        />
      )}

      {uploadOpen && (
        <UploadProductModal
          can={can}
          onClose={() => setUploadOpen(false)}
          onCreated={() => {
            load();
            onPointsChanged?.();
          }}
        />
      )}
    </div>
  );
}

function marketLabel(m) {
  return { official: '官方市场', standard: '标准市场', flea: '跳蚤市场' }[m] || m;
}

function categoryLabel(c) {
  return (
    {
      goods: '普通商品',
      background: '聊天背景',
      bubble: '气泡主题',
      sticker_pack: '表情包'
    }[c] || '普通商品'
  );
}

function statusLabel(s) {
  return (
    {
      on_sale: '在售',
      pending_review: '待审核',
      sold: '已售出',
      delisted: '已下架',
      pirated: '盗版下架',
      hidden: '已隐藏'
    }[s] || s
  );
}