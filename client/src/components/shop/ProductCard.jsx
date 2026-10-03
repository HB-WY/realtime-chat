import Avatar from '../common/Avatar';
import ProtectedImage from '../common/ProtectedImage';

export default function ProductCard({
  product,
  onClick,
  canManage,
  canHide,
  onDelist,
  onHide
}) {
  return (
    <div className="product-card" onClick={onClick}>
      <div className="product-cover">
        {product.coverUrl ? (
          /* 卡片封面：同样不许右键另存 / 拖拽（ProtectedImage，见其顶部说明） */
          <ProtectedImage src={product.coverUrl} alt={product.title} loading="lazy" />
        ) : (
          <div className="product-cover-placeholder">
            {product.title.slice(0, 1)}
          </div>
        )}
        <span className={`market-tag market-${product.market}`}>
          {marketLabel(product.market)}
        </span>
        {product.category && product.category !== 'goods' && (
          <span className="category-tag">{categoryLabel(product.category)}</span>
        )}
      </div>

      <div className="product-info">
        <div className="product-title">{product.title}</div>
        <div className="product-desc">{product.description || '—'}</div>
        <div className="product-foot">
          <div className="product-seller">
            <Avatar
              name={product.sellerName}
              avatar={product.sellerAvatar}
              size={20}
            />
            <span>{product.sellerName}</span>
          </div>
          <div className="product-price">
            {product.price > 0 ? `${product.price} 积分` : '免费'}
          </div>
        </div>
      </div>

      {(canManage || canHide) && (
        <div className="product-admin" onClick={(e) => e.stopPropagation()}>
          {canHide && (
            <button className="mini-btn" onClick={onHide}>
              隐藏
            </button>
          )}
          {canManage && (
            <button className="mini-btn danger" onClick={onDelist}>
              下架
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function marketLabel(m) {
  return { official: '官方', standard: '标准', flea: '跳蚤' }[m] || m;
}

function categoryLabel(c) {
  return (
    {
      goods: '普通商品',
      background: '聊天背景',
      bubble: '气泡主题',
      sticker_pack: '表情包'
    }[c] || c
  );
}
