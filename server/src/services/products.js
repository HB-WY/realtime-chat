// src/services/products.js
//
// 商品 / 定价 / 购买。
//
// 【本次改动】
//   · getProductDetail 对 sticker_pack：不返回文件 URL（只给 id/name/size 展示数量），
//     并且返回 grantedPackId（买家已购买时能跳转到自己获得的表情包）
//   · 表情包购买走独立链路（sticker_packs），文件不再进入买家 assets
//
// [NEW] 表情包商品：**作者上架时自己也获得一份**（进自己的表情库）。
//   原因：作者上架的表情包本来就是他自己的东西，但之前的逻辑只在
//   买家购买时给买家发一份，作者反而看不到自己上架的包 —— 用户反馈
//   "上架的表情包应该直接加到用户的表情包库"，createProduct 里补上。
//
const fs = require('fs');
const { db, OFFICIAL_USER_ID } = require('../db');
const { transaction } = require('../db/tx');
const { changePoints } = require('./points');
const { sha256, simhash, detectPlagiarism } = require('./plagiarism');
const { audit } = require('./permissions');
const assets = require('./assets');
const { normalizeImageUrl } = require('../utils/url');

const config = require('../config');
const SHOP_CFG = config.BUSINESS.shop;
const MARKETS  = SHOP_CFG.markets;
const CATEGORIES = SHOP_CFG.categories || ['goods'];
const APPEARANCE = CATEGORIES.filter((c) => c !== 'goods');
const PRICE_MIN = SHOP_CFG.price.min;
const PRICE_MAX = SHOP_CFG.price.max;

const ASSET_KIND_BY_CATEGORY = {
  background: 'background',
  bubble: 'bubble',
  sticker_pack: 'sticker'
};

function isAppearance(category) {
  return APPEARANCE.includes(category);
}

// ============================================================
// 素材哈希
// ============================================================
function fileDigest(files) {
  const hashes = [];
  for (const f of files || []) {
    const abs = assets.absFromUrl(f.url);
    if (!abs || !fs.existsSync(abs)) continue;
    try {
      hashes.push(assets.sha256File(abs));
    } catch { /* 忽略不可读文件 */ }
  }
  if (hashes.length === 0) return null;
  hashes.sort();
  return sha256(hashes.join(':'));
}

function fileMime(f) {
  return (f.mime || f.type || '').toString().toLowerCase();
}

function isImageFile(f) {
  const mime = fileMime(f);
  if (mime.startsWith('image/')) return true;
  if (mime === 'image') return true;
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name || f.file_name || '');
}

function isJsonFile(f) {
  const mime = fileMime(f);
  if (mime === 'application/json') return true;
  return /\.json$/i.test(f.name || f.file_name || '');
}

// ============================================================
// 上架
// ============================================================
const createProduct = transaction((p) => {
  if (!MARKETS.includes(p.market)) throw new Error('未知市场');

  const category = CATEGORIES.includes(p.category) ? p.category : 'goods';
  const appearance = isAppearance(category);

  const isOfficialMarket = p.market === 'official';
  const sellerId = isOfficialMarket ? OFFICIAL_USER_ID : p.sellerId;

  let finalPrice = 0;
  let status = 'on_sale';

  if (p.market === 'flea') {
    finalPrice = Number(p.price);
    if (!Number.isInteger(finalPrice) || finalPrice < PRICE_MIN || finalPrice > PRICE_MAX) {
      throw new Error(`自主定价需为 ${PRICE_MIN}-${PRICE_MAX} 的整数`);
    }
  } else if (p.market === 'standard') {
    finalPrice = 0;
    status = 'pending_review';
  } else {
    finalPrice = Number(p.price);
    if (!Number.isInteger(finalPrice) || finalPrice < PRICE_MIN || finalPrice > PRICE_MAX) {
      throw new Error(`官方定价需为 ${PRICE_MIN}-${PRICE_MAX} 的整数`);
    }
  }

  const files = Array.isArray(p.files) ? p.files : [];

  // [SEC] 商品文件必须真实存在于商品上传目录（uploads/shop）内，
  //       **且属于上架者本人上传**（shop_uploads 归属表）——
  //       否则拿到他人 file_url 就能把别人的付费交付物挂到自己名下卖。
  for (const f of files) {
    const abs = assets.absFromUrl((f && f.url) || '');
    if (!abs || !assets.isInsideDir(abs, config.SHOP_DIR) || !fs.existsSync(abs)) {
      throw new Error('商品文件不合法：请先通过商城上传接口上传文件');
    }
    const owned = db.prepare(
      'SELECT 1 FROM shop_uploads WHERE file_url = ? AND owner_id = ?'
    ).get(f.url, p.sellerId);
    if (!owned) {
      throw new Error('商品文件不合法：只能使用自己上传的文件');
    }
  }

  if (appearance) {
    if (!files.some(isImageFile)) {
      throw new Error('外观素材商品至少需要一张图片文件');
    }
  }

  const textForHash = `${p.title}\n${p.description || ''}`;
  const contentHash = sha256(textForHash);
  const sh = simhash(textForHash);
  const simhashStr = sh.toString();
  const fileHash = fileDigest(files);

  // [FIX] 防抄袭检测带类目：不同类目（goods vs 表情包）文案相似不该互拦
  const hits = detectPlagiarism({ sellerId, category, contentHash, simhash: sh, fileHash });

  let piratedOf = null;
  let delistReason = null;
  if (hits.length > 0) {
    status = 'pirated';
    piratedOf = hits[0].productId;
    delistReason = `防抄袭：与原商品 #${piratedOf} ${hits[0].reason}`;
  }

  const reviewMode = p.market === 'flea' ? 'self' : 'official';
  const now = Date.now();

  const coverUrl = normalizeImageUrl(p.coverUrl, '商品封面');

  const info = db.prepare(
    `INSERT INTO products
      (seller_id, title, description, price,
       cover_url, market, category, status, review_mode,
       content_hash, simhash, file_hash, pirated_of, delist_reason,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sellerId, p.title, p.description || '', finalPrice,
    coverUrl, p.market, category, status, reviewMode,
    contentHash, simhashStr, fileHash, piratedOf, delistReason,
    now, now
  );
  const productId = Number(info.lastInsertRowid);

  const insertFile = db.prepare(
    `INSERT INTO product_files
      (product_id, file_url, file_name, file_type, file_size, sort_order, is_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  files.forEach((f, i) => {
    insertFile.run(
      productId,
      f.url,
      (f.name || '未命名').slice(0, 200),
      f.type || null,
      Number.isFinite(f.size) ? f.size : null,
      i,
      f.isPreview ? 1 : 0,
      now
    );
  });

  // ============================================================
  // [NEW] 表情包商品：上架时作者自己获得一份（进他自己的表情库）
  //
  //   为什么：作者上架的表情包本来就是他自己的东西，但之前的逻辑只在
  //   买家购买时给买家发一份，作者反而看不到自己上架的包。用户反馈
  //   "上架的表情包应该直接加到用户的表情包库"，这里补上。
  //
  //   边界：
  //     · 只对 sticker_pack 分类发放（background / bubble 的素材本来
  //       就在资源池 assets 里，不走"独立表情库"这套）
  //     · status === 'pirated' 时不发（抄袭被判下架的不该给）
  //     · 作者已有一份同 product_id 的包时跳过（重新上架/改价时避免重复）
  //     · 发放失败不能影响上架本身（catch 后只记日志）
  // ============================================================
  if (category === 'sticker_pack' && status !== 'pirated') {
    try {
      const stickers = require('./stickers');
      const alreadyHas = db.prepare(
        `SELECT id FROM sticker_packs
          WHERE owner_id = ? AND product_id = ?
          LIMIT 1`
      ).get(p.sellerId, productId);
      if (!alreadyHas) {
        stickers.grantPackFromProduct({
          ownerId: p.sellerId,
          name: p.title,
          description: p.description || '',
          files: files.map((f) => ({ url: f.url, name: f.name, mime: f.type })),
          coverUrl: coverUrl,
          productId,
          source: 'author'
        });
      }
    } catch (err) {
      // 发不进自己的库不能阻止上架，但要留日志
      console.error('[shop create] 给作者发放表情包失败:', err);
    }
  }

  if (isOfficialMarket) {
    audit(p.actorId, p.actorRole, 'official_publish', 'product', productId, p.title);
  }

  return {
    id: productId, status, market: p.market, price: finalPrice,
    category, piratedOf, delistReason, hits,
    message: piratedOf
      ? `检测到抄袭，已自动下架：${delistReason}`
      : (p.market === 'standard'
          ? '已提交官方评估，等待开发者定价'
          : p.market === 'official'
            ? '官方商品已上架'
            : '已上架到跳蚤市场')
  };
});

// ============================================================
// 定价审核
// ============================================================
function reviewOfficialPrice(productId, reviewerId, reviewerRole, price, note) {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!prod) throw new Error('商品不存在');
  if (prod.market !== 'standard') throw new Error('该商品不在标准市场');
  if (prod.status !== 'pending_review') throw new Error('该商品不在待审核状态');
  if (!Number.isInteger(price) || price < PRICE_MIN || price > PRICE_MAX) {
    throw new Error(`定价需为 ${PRICE_MIN}-${PRICE_MAX} 的整数`);
  }

  db.prepare(
    `UPDATE products SET status = 'on_sale', price = ?, reviewed_by = ?, reviewed_at = ?,
                         review_note = ?, updated_at = ? WHERE id = ?`
  ).run(price, reviewerId, Date.now(), note || null, Date.now(), productId);

  audit(reviewerId, reviewerRole, 'review_price', 'product', productId,
        `标准市场定价 ${price}${note ? '：' + note : ''}`);
}

// ============================================================
// 购买后把外观素材归入买家资源库
// ============================================================
function readBubbleTheme(files) {
  const jsonFile = files.find(isJsonFile);
  if (!jsonFile) return null;
  const abs = assets.absFromUrl(jsonFile.url || jsonFile.file_url);
  if (!abs || !assets.isInsideDir(abs, config.SHOP_DIR) || !fs.existsSync(abs)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const prefs = require('./preferences');
    return prefs.normalizeBubble(raw);
  } catch {
    return null;
  }
}

function grantAppearance(prod, buyerId, rawFiles) {
  if (SHOP_CFG.grant_assets === false) return { granted: 0, packId: null };
  if (!isAppearance(prod.category)) return { granted: 0, packId: null };

  const files = (rawFiles || []).map((f) => ({
    url: f.file_url ?? f.url,
    name: f.file_name ?? f.name,
    type: f.file_type ?? f.type,
    size: f.file_size ?? f.size
  }));

  const images = files.filter(isImageFile);
  const kind = ASSET_KIND_BY_CATEGORY[prod.category] || 'image';

  // 表情包商品：走 sticker_packs（独立库），不进 assets
  if (prod.category === 'sticker_pack') {
    const stickers = require('./stickers');
    const packId = stickers.grantPackFromProduct({
      ownerId: buyerId,
      name: prod.title,
      description: prod.description || '',
      files: images.map((f) => ({ url: f.url, name: f.name, mime: f.type })),
      coverUrl: prod.cover_url || null,
      productId: prod.id
    });
    return { granted: images.length, packId };
  }

  const theme = prod.category === 'bubble' ? readBubbleTheme(files) : null;
  let granted = 0;
  for (const f of images) {
    assets.grantFromProductFile({
      ownerId: buyerId,
      fileUrl: f.url,
      fileName: f.name,
      mime: f.type,
      kind,
      meta: theme,
      productId: prod.id
    });
    granted++;
  }
  return { granted, packId: null };
}

// ============================================================
// 购买
// ============================================================
const purchaseProduct = transaction((productId, buyerId) => {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!prod) throw new Error('商品不存在');
  if (prod.status !== 'on_sale') throw new Error('商品不在售');
  if (prod.seller_id === buyerId) throw new Error('不能买自己的商品');

  const category = prod.category || 'goods';
  const appearance = isAppearance(category);

  const exists = db.prepare(
    'SELECT id FROM orders WHERE product_id = ? AND buyer_id = ? AND status = ?'
  ).get(productId, buyerId, 'paid');
  if (exists) throw new Error('已购买过该商品');

  changePoints(buyerId, -prod.price, 'purchase', 'product', productId, prod.title);
  changePoints(prod.seller_id, prod.price, 'sale', 'product', productId, prod.title);

  const info = db.prepare(
    `INSERT INTO orders (product_id, buyer_id, seller_id, price, status, created_at)
     VALUES (?, ?, ?, ?, 'paid', ?)`
  ).run(productId, buyerId, prod.seller_id, prod.price, Date.now());

  const files = db.prepare(
    'SELECT * FROM product_files WHERE product_id = ? ORDER BY sort_order'
  ).all(productId);

  const granted = grantAppearance(prod, buyerId, files);

  if (appearance) {
    // 外观素材可被多人购买（数字素材授权）
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(Date.now(), productId);
  } else {
    db.prepare("UPDATE products SET status = 'sold', updated_at = ? WHERE id = ?")
      .run(Date.now(), productId);
  }

  return {
    orderId: Number(info.lastInsertRowid),
    product: prod,
    category,
    grantedAssets: granted.granted,
    grantedPackId: granted.packId
  };
});

// ============================================================
// 下架
// ============================================================
function delistProduct(productId, actorId, actorRole, reason) {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!prod) throw new Error('商品不存在');
  // [FIX] pirated 不再是死状态：被误判抄袭的商品管理员必须能下架 / 清理。
  //   （hide 通道同样放开了对 pirated 的限制，见 shop_admin.js）
  if (prod.status === 'delisted') throw new Error('商品已下架');

  db.prepare(
    `UPDATE products SET status = 'delisted', delist_reason = ?, updated_at = ? WHERE id = ?`
  ).run(reason || '管理员下架', Date.now(), productId);

  audit(actorId, actorRole, 'delist', 'product', productId, reason || '管理员下架');
}

// ============================================================
// 商品详情
// ============================================================
function getProductDetail(productId, userId) {
  const p = db.prepare(
    `SELECT p.*, u.nickname AS sellerName, u.avatar AS sellerAvatar
     FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = ?`
  ).get(productId);
  if (!p) return null;

  const isStickerPack = (p.category || 'goods') === 'sticker_pack';

  let files = db.prepare(
    `SELECT id, file_name AS name, file_type AS type, file_size AS size,
            sort_order AS sortOrder, is_preview AS isPreview
     FROM product_files WHERE product_id = ? ORDER BY sort_order`
  ).all(productId).map((f) => ({ ...f, isPreview: !!f.isPreview }));

  // 表情包商品：文件 URL 不下发（下载通道已禁），只留展示字段
  if (isStickerPack) {
    files = files.map((f) => ({ ...f, isPreview: false, locked: true }));
  }

  const bought = !!db.prepare(
    "SELECT 1 FROM orders WHERE product_id = ? AND buyer_id = ? AND status = 'paid'"
  ).get(productId, userId);

  const isSeller = p.seller_id === userId;

  // 表情包商品：如果已经购买，返回其表情包 id（供前端"打开我的表情包"跳转）
  // [FIX] 按 sticker_packs.product_id 直查。原实现按 owner+source+name 反查，
  //   两个同名商品会互相串，且发货时从未回写 assets.ref_id。
  let grantedPackId = null;
  if (isStickerPack && bought) {
    const row = db.prepare(
      `SELECT sp.id
       FROM sticker_packs sp
       JOIN user_sticker_packs usp ON usp.pack_id = sp.id
       WHERE sp.owner_id = ? AND sp.source = 'purchase' AND sp.product_id = ?
       ORDER BY sp.id DESC LIMIT 1`
    ).get(userId, p.id);
    grantedPackId = row?.id || null;
  }

  return {
    product: {
      id: p.id,
      title: p.title,
      description: p.description,
      price: p.price,
      market: p.market,
      category: p.category || 'goods',
      status: p.status,
      reviewMode: p.review_mode,
      coverUrl: p.cover_url,
      sellerId: p.seller_id,
      sellerName: p.sellerName,
      sellerAvatar: p.sellerAvatar,
      createdAt: p.created_at
    },
    files,
    bought,
    isSeller,
    grantedPackId
  };
}

module.exports = {
  createProduct, reviewOfficialPrice, purchaseProduct, delistProduct,
  getProductDetail, MARKETS, CATEGORIES, OFFICIAL_USER_ID,
  isAppearance, grantAppearance
};