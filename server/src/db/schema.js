// src/db/schema.js
//
// 【历史改动】
//   新增第 7 段「支付系统」：transfers / red_packets / red_packet_grants 三张表。
//   messages 表追加 ref_type / ref_id 两列（放在建表之后，§1.50 教训）。
//
//   【新增 4 张表】plugins / user_plugins / plugin_kv / plugin_payments
//
//   【双 token 认证】refresh_tokens —— Refresh Token 落库
//
// 【本次改动 · 插件系统 v3】
//   · 新增 plugin_versions 表 —— 记录每个历史版本的归档目录 + manifest 快照 + changelog
//   · 每次 publish 新版本时，先归档旧版到 uploads/plugins/.history/<id>/<ver>/
//     再更新 plugins 表，同时写一条 plugin_versions 记录
//
function addCol(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] 迁移: ${table}.${column} 已添加`);
  }
}

module.exports = function setupSchema(db) {
  // ============================================================
  // 1) 基础表
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      banned_at INTEGER,
      banned_by INTEGER,
      ban_reason TEXT,
      last_promoted_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_type TEXT NOT NULL DEFAULT 'public',
      room_id TEXT NOT NULL DEFAULT 'public',
      sender_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      sender_avatar TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      reply_to_id TEXT,
      reply_to_name TEXT,
      reply_to_text TEXT,
      file_url TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_points (
      user_id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 50,
      frozen INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS points_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL,
      file_url TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      cover_url TEXT,
      market TEXT NOT NULL DEFAULT 'flea',
      status TEXT NOT NULL DEFAULT 'pending_review',
      review_mode TEXT NOT NULL DEFAULT 'self',
      reviewed_by INTEGER,
      reviewed_at INTEGER,
      review_note TEXT,
      content_hash TEXT NOT NULL,
      simhash TEXT NOT NULL,
      pirated_of INTEGER,
      delist_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      file_url TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_preview INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS download_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      ip TEXT,
      ua TEXT,
      referer TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      buyer_id INTEGER NOT NULL,
      seller_id INTEGER NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      reviewed_by INTEGER,
      reviewed_at INTEGER,
      review_note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_msg_room        ON messages(room_type, room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_frq_to          ON friend_requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_grq_group       ON group_requests(group_id, status);
    CREATE INDEX IF NOT EXISTS idx_ptx_user        ON points_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_market ON products(market, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_hash   ON products(content_hash);
    CREATE INDEX IF NOT EXISTS idx_pfiles_product  ON product_files(product_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_dl_user         ON download_logs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dl_product      ON download_logs(product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer    ON orders(buyer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_seller   ON orders(seller_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created   ON admin_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rr_user         ON role_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rr_status       ON role_requests(status, created_at DESC);

    -- [FIX] 高频查询补索引（原缺失，走全表扫）：
    CREATE INDEX IF NOT EXISTS idx_friendship_friend ON friendships(friend_id);
    CREATE INDEX IF NOT EXISTS idx_frq_from        ON friend_requests(from_id, status);
    CREATE INDEX IF NOT EXISTS idx_grq_user        ON group_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_groups_owner    ON groups(owner_id);
    CREATE INDEX IF NOT EXISTS idx_orders_product  ON orders(product_id, buyer_id);
    CREATE INDEX IF NOT EXISTS idx_msg_sender      ON messages(sender_id);

    -- 商品上传归属表：/api/shop/upload 落盘时记录 owner，
    -- createProduct 校验 file_url 属于上架者本人（防「挂卖他人交付物」）
    CREATE TABLE IF NOT EXISTS shop_uploads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id    INTEGER NOT NULL,
      file_url    TEXT NOT NULL UNIQUE,
      file_name   TEXT,
      file_size   INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shop_uploads_owner ON shop_uploads(owner_id, created_at DESC);
  `);

  // ============================================================
  // 2) 老库补列
  // ============================================================
  addCol(db, 'users',    'avatar',          "TEXT NOT NULL DEFAULT ''");
  addCol(db, 'users',    'signature',       "TEXT NOT NULL DEFAULT ''");
  addCol(db, 'users',    'role',            "TEXT NOT NULL DEFAULT 'user'");
  addCol(db, 'users',    'status',          "TEXT NOT NULL DEFAULT 'active'");
  addCol(db, 'users',    'banned_at',       'INTEGER');
  addCol(db, 'users',    'banned_by',       'INTEGER');
  addCol(db, 'users',    'ban_reason',      'TEXT');
  addCol(db, 'users',    'last_promoted_at','INTEGER');
  addCol(db, 'messages', 'sender_avatar',   "TEXT NOT NULL DEFAULT ''");
  addCol(db, 'messages', 'room_type',       "TEXT NOT NULL DEFAULT 'public'");
  addCol(db, 'messages', 'room_id',         "TEXT NOT NULL DEFAULT 'public'");
  addCol(db, 'messages', 'file_url',        'TEXT');
  addCol(db, 'messages', 'file_name',       'TEXT');
  addCol(db, 'messages', 'file_type',       'TEXT');
  addCol(db, 'messages', 'file_size',       'INTEGER');
  addCol(db, 'products', 'market',          "TEXT NOT NULL DEFAULT 'flea'");
  addCol(db, 'products', 'category',        "TEXT NOT NULL DEFAULT 'goods'");
  addCol(db, 'products', 'file_hash',       'TEXT');
  addCol(db, 'messages', 'is_sticker',      'INTEGER NOT NULL DEFAULT 0');

  // ============================================================
  // 3) 统一资源池 / 表情包 / 个性化偏好 / API 密钥 / 房间设置
  //    + 双 token 认证的 Refresh Token
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id     INTEGER PRIMARY KEY,
      background  TEXT,
      bubble      TEXT,
      font_size   INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_preferences (
      user_id     INTEGER NOT NULL,
      room_key    TEXT NOT NULL,
      background  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, room_key)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id    INTEGER NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'image',
      sha256      TEXT NOT NULL,
      url         TEXT NOT NULL,
      file_name   TEXT,
      mime        TEXT,
      size        INTEGER,
      meta        TEXT,
      source      TEXT NOT NULL DEFAULT 'upload',
      ref_type    TEXT,
      ref_id      INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_owner_sha  ON assets(owner_id, kind, sha256);
    CREATE INDEX        IF NOT EXISTS idx_assets_owner_kind ON assets(owner_id, kind, created_at DESC);
    CREATE INDEX        IF NOT EXISTS idx_assets_sha        ON assets(owner_id, sha256);

    CREATE TABLE IF NOT EXISTS sticker_packs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id    INTEGER NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cover_url   TEXT,
      is_public   INTEGER NOT NULL DEFAULT 0,
      share_code  TEXT,
      source      TEXT NOT NULL DEFAULT 'user',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_packs_code  ON sticker_packs(share_code);
    CREATE INDEX        IF NOT EXISTS idx_sticker_packs_owner ON sticker_packs(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sticker_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id     INTEGER NOT NULL,
      asset_id    INTEGER,
      url         TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id, sort_order);

    CREATE TABLE IF NOT EXISTS user_sticker_packs (
      user_id   INTEGER NOT NULL,
      pack_id   INTEGER NOT NULL,
      source    TEXT NOT NULL DEFAULT 'subscribe',
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, pack_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      key_hash     TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      bound_ip     TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      last_ip      TEXT,
      revoked_at   INTEGER,
      revoked_by   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user   ON api_keys(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

    CREATE TABLE IF NOT EXISTS apikey_ip_claims (
      ip          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      released_at INTEGER,
      released_by INTEGER,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ip_claims_user ON apikey_ip_claims(user_id);

    CREATE TABLE IF NOT EXISTS room_settings (
      room_key   TEXT PRIMARY KEY,
      icon       TEXT NOT NULL DEFAULT '',
      updated_by INTEGER,
      updated_at INTEGER NOT NULL
    );

    -- [NEW] Refresh Token（双 token 认证体系的长期凭据）
    --   · 只存 SHA-256 哈希（明文只在签发时进 Set-Cookie）
    --   · family_id：同一条链上的所有 token 共享，检测到重放时整族作废
    --   · replaced_by：轮换时指向新 token 的 id，便于审计
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      family_id    TEXT NOT NULL,
      user_agent   TEXT NOT NULL DEFAULT '',
      ip           TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      replaced_by  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rt_user    ON refresh_tokens(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS idx_rt_expiry  ON refresh_tokens(expires_at);
  `);

  // ============================================================
  // 4) 后置补列 —— 必须放在所有建表之后
  // ============================================================
  addCol(db, 'api_keys', 'bound_ip', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_filehash  ON products(file_hash);
    CREATE INDEX IF NOT EXISTS idx_gm_user            ON group_members(user_id, group_id);
    CREATE INDEX IF NOT EXISTS idx_sticker_items_url  ON sticker_items(url);
  `);

  addCol(db, 'sticker_items', 'sha256', 'TEXT');
  addCol(db, 'sticker_items', 'size',   'INTEGER');
  addCol(db, 'messages', 'sticker_pack_id', 'INTEGER');
  // 表情包来源商品 id（购买发放的表情包记录来源，供商品跳转反查）
  addCol(db, 'sticker_packs', 'product_id', 'INTEGER');

  // ============================================================
  // 5) 插件系统（P1–P5 + 版本历史）
  // ============================================================
  db.exec(`
    -- ---------- 插件本体 ----------
    -- id 用 manifest 里的 id（小写字母/数字/连字符）。同一 id 只有一个"当前版本"。
    -- bundle_dir 是 uploads/plugins/{id}/，**不静态暴露**，只走 /api/plugins/:id/entry 或 /p/。
    CREATE TABLE IF NOT EXISTS plugins (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      icon_url     TEXT,
      manifest     TEXT NOT NULL,       -- 完整 manifest JSON 文本
      entry        TEXT NOT NULL,       -- 入口文件相对路径（相对 bundle_dir）
      bundle_dir   TEXT NOT NULL,       -- 解包后的目录绝对路径
      permissions  TEXT NOT NULL,       -- JSON 数组：manifest 声明的权限
      is_public    INTEGER NOT NULL DEFAULT 0,
      share_code   TEXT UNIQUE,
      status       TEXT NOT NULL DEFAULT 'active',  -- active | hidden | delisted
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugins_owner  ON plugins(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugins_public ON plugins(is_public, status, created_at DESC);

    -- ---------- 用户安装关系 ----------
    -- granted_perms 是**用户实际批准**的权限，可能少于 manifest.permissions。
    -- 宿主每次桥调用都按这一列判权限，不信任 manifest。
    CREATE TABLE IF NOT EXISTS user_plugins (
      user_id       INTEGER NOT NULL,
      plugin_id     TEXT NOT NULL,
      installed_at  INTEGER NOT NULL,
      granted_perms TEXT NOT NULL,      -- JSON 数组
      PRIMARY KEY (user_id, plugin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_plugins_user ON user_plugins(user_id, installed_at DESC);

    -- ---------- 插件 KV 存储 ----------
    -- 主键三元组：插件 × 用户 × key
    -- 插件拿不到别的插件的数据，也拿不到别的用户的数据。
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin_id  TEXT NOT NULL,
      user_id    INTEGER NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, user_id, key)
    );

    -- ---------- 插件支付 ----------
    -- 幂等键：(plugin_id, buyer_id, order_id)
    -- 每次支付由服务端在**事务**里扣买家积分 + 加卖家积分 + 写流水 + 写本表。
    CREATE TABLE IF NOT EXISTS plugin_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id       TEXT NOT NULL,
      buyer_id        INTEGER NOT NULL,
      seller_id       INTEGER NOT NULL,
      amount          INTEGER NOT NULL,
      subject         TEXT NOT NULL,
      order_id        TEXT NOT NULL,     -- 插件侧幂等 ID
      status          TEXT NOT NULL,     -- paid | refunded
      transaction_id  TEXT NOT NULL UNIQUE,
      metadata        TEXT,              -- JSON
      created_at      INTEGER NOT NULL,
      paid_at         INTEGER,
      refunded_at     INTEGER,
      refunded_by     INTEGER,
      refund_reason   TEXT,
      UNIQUE (plugin_id, buyer_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pp_buyer    ON plugin_payments(buyer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pp_seller   ON plugin_payments(seller_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pp_plugin   ON plugin_payments(plugin_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pp_created  ON plugin_payments(created_at DESC);

    -- ---------- [NEW] 插件版本历史 ----------
    -- 每次 publish 新版本时，把**当前**版本的 bundle 复制到
    -- uploads/plugins/.history/<id>/<version>/，然后在这里留一条记录。
    -- 用途：
    --   · 详情对话框展示历史版本
    --   · 用户端对比"已安装版本"与"最新版本"
    --   · 未来若支持回滚，从这里恢复
    CREATE TABLE IF NOT EXISTS plugin_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id     TEXT NOT NULL,
      version       TEXT NOT NULL,
      bundle_dir    TEXT NOT NULL,   -- 归档目录的绝对路径
      manifest      TEXT NOT NULL,   -- 该版本的 manifest JSON 快照
      changelog     TEXT,            -- 可选：作者填的更新说明
      uploaded_by   INTEGER NOT NULL,
      uploaded_at   INTEGER NOT NULL,
      UNIQUE (plugin_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_versions_pid
      ON plugin_versions(plugin_id, uploaded_at DESC);
  `);

  // ============================================================
  // 6) 支付系统（转账 + 红包）
  //
  //   · transfers          —— 一对一转账（待收款 → 收款/退还/超时退回）
  //   · red_packets        —— 红包本体（拼手气/固定、剩余金额与个数）
  //   · red_packet_grants  —— 每一份被谁抢到
  //
  //   托管方为官方系统账户 OFFICIAL_USER_ID：
  //     发送 → 发送者 -总额、官方 +总额（两笔 changePoints 流水）
  //     领取 → 官方 -本次、领取者 +本次
  //     退回 → 官方 -剩余、发送者 +剩余
  //   这样 points_transactions 天然双边记账、可审计。
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id      INTEGER NOT NULL,
      to_id        INTEGER NOT NULL,
      amount       INTEGER NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | expired
      message_id   TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      settled_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_from   ON transfers(from_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_to     ON transfers(to_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_expiry ON transfers(status, expires_at);

    CREATE TABLE IF NOT EXISTS red_packets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id         INTEGER NOT NULL,
      room_type         TEXT NOT NULL,               -- private | group
      room_id           TEXT NOT NULL,
      total_amount      INTEGER NOT NULL,
      total_count       INTEGER NOT NULL,
      remaining_amount  INTEGER NOT NULL,
      remaining_count   INTEGER NOT NULL,
      mode              TEXT NOT NULL DEFAULT 'lucky', -- lucky | fixed
      note              TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'active', -- active | empty | expired
      message_id        TEXT,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      emptied_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_redpackets_room   ON red_packets(room_type, room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_redpackets_sender ON red_packets(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_redpackets_expiry ON red_packets(status, expires_at);

    CREATE TABLE IF NOT EXISTS red_packet_grants (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      red_packet_id  INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      amount         INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      UNIQUE (red_packet_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rpg_user ON red_packet_grants(user_id, created_at DESC);
  `);

  // messages 表加两列：ref_type / ref_id。
  // 这两列让"转账 / 红包"可以作为一条普通消息出现（text 为空），
  // 从而复用聊天历史、分页、未读、右键盘等全部现有能力。
  addCol(db, 'messages', 'ref_type', 'TEXT');
  addCol(db, 'messages', 'ref_id',   'INTEGER');

  // ============================================================
  // 7) 一次性数据清理
  // ============================================================
  const legacyRecalled = db.prepare(
    "SELECT id FROM messages WHERE text = '[消息已撤回]'"
  ).all();
  if (legacyRecalled.length > 0) {
    const ids = legacyRecalled.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM message_reads WHERE message_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...ids);
    console.log(`[db] 清理 ${ids.length} 条历史「消息已撤回」占位行（撤回现已改为直接删除）`);
  }
};