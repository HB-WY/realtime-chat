#!/usr/bin/env node
/**
 * payments_check.mjs —— 转账 + 红包的端到端回归。
 *
 * 自包含：临时配置 + 临时空库 + 隔离端口（默认 3102），跑完清理干净。
 * 不需要先启动服务，也不碰 server/chat.db。
 *
 * 覆盖：
 *   1.  准备账号（注册 3 个用户）
 *   2.  转账：发起 / 收款 —— 余额与托管检查
 *   3.  转账：退还 —— 余额回滚检查
 *   4.  转账边界（给自己 / 金额 0 / 超上限 / 收款人不存在）
 *   5.  建群（直接写库，跳过好友校验）
 *   6.  红包：拼手气 —— 抢、重复抢、自己抢、剩余守恒
 *   7.  红包：固定 + 抢完
 *   8.  红包边界（总额 0 / 份数超上限 / 非成员抢）
 *   9.  私聊红包（一对一 + count > 1 拒绝）
 *   10. 并发抢红包：10 人同时抢 10 份，金额总和 == 总额
 *   11. 托管对账：官方账户**增量** == pending 转账 + active 红包剩余
 *       （官方账户在 seed 时就带 signup_points 初始余额，
 *        所以必须比较"跑测试前后"的增量，而不是绝对值）
 *
 * 使用：node scripts/payments_check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;
const PROC_ROOT = path.resolve(import.meta.dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payments-check-'));
const DB_PATH = path.join(TMP_ROOT, 'chat.db');
const UPLOAD_ROOT = path.join(TMP_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// ────────────────────────────────────────────────────────
// 断言框架
// ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(
    actual === expected,
    `${msg}  (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`
  );
}

// ────────────────────────────────────────────────────────
// HTTP helper
// ────────────────────────────────────────────────────────
async function api(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应体 */ }
  return { status: res.status, data };
}

// ────────────────────────────────────────────────────────
// 配置 / 启动
// ────────────────────────────────────────────────────────
function writeConfig() {
  const cfgPath = path.join(TMP_ROOT, 'config.yaml');
  const up = UPLOAD_ROOT.replace(/\\/g, '/');
  const db = DB_PATH.replace(/\\/g, '/');
  fs.writeFileSync(cfgPath, `
server:
  port: ${PORT}
  host: 127.0.0.1
  env: test

# 单端口托管关闭：本脚本只测后端
client:
  serve: false
  dist: ../client/dist

database:
  path: ${db}
  journal_mode: WAL
  foreign_keys: true

uploads:
  root: ${up}
  subdirs:
    avatars: avatars
    files: files
    shop: shop
    covers: covers
    custom: custom
    tmp: tmp
    plugins: plugins
  limits:
    avatar: 8388608
    file: 104857600
    shop_file: 209715200
    cover: 5242880
    asset: 10485760
  avatar:
    allowed_ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp']
    allowed_mime_prefix: 'image/'
    max_url_len: 500
    max_data_url_len: 200000

security:
  jwt:
    secret: 'payments-check-secret-do-not-use'
    expiresIn: 1h
  apikey:
    prefix_len: 12
    secret_len: 40
    max_per_user: 10
    ip_binding: false
  allowed_referer_hosts: []
  trust_proxy: false
  presence:
    scope: related
  blocked_ext: '\\.(html?|xhtml|svg|xml|js|mjs|cjs|css|htm)$'
  blocked_mime:
    - text/html
    - image/svg+xml

files:
  types: []

static:
  expose: [avatars, files, covers, custom]

business:
  signup_points: 100000
  shop:
    markets: [standard, official, flea]
    categories: [goods]
    price: { min: 0, max: 100000 }
    title: { min_len: 2, max_len: 80 }
    description_max_len: 2000
    files: { min: 1, max: 20 }
    plagiarism: { similarity_threshold: 95, candidate_limit: 500 }
    grant_assets: true
  assets:
    quota_bytes: 209715200
    batch_max_bytes: 209715200
    max_files_per_request: 50
    allowed_ext: ['.png']
    allowed_mime: ['image/png']
  stickers:
    max_packs_per_user: 30
    max_items_per_pack: 200
    name_max_len: 30
    description_max_len: 200
    share_code_len: 10
  preferences:
    background_max_len: 500
    bubble_max_len: 4000
    font_size: { min: 12, max: 20 }
    max_rooms: 200
  message:
    text_max_len: 2000
    recall_window_ms: 120000
    history_limit: 200
  user:
    username: { min_len: 2, max_len: 20 }
    password: { min_len: 6 }
    nickname: { min_len: 1, max_len: 20 }
    group_name: { max_len: 30 }

rate_limits:
  socket:
    message: { per_second: 100, per_minute: 2000 }
    write:   { per_second: 100, per_minute: 2000 }
  # [CHANGED] 本套脚本要批量注册 10+ 用户、密集上传，放宽新加的限流
  register: { window_ms: 3600000, max_per_ip: 1000 }
  upload: { window_ms: 60000, max: 1000 }
  media_status: { window_ms: 60000, max: 1000 }
  download: { window_ms: 60000, max: 100 }
  preview: { window_ms: 60000, max: 600 }
  apikey: { window_ms: 60000, max: 600 }
  login: { window_ms: 900000, max_per_ip: 30, max_per_account: 10 }
  plugin: { window_ms: 60000, max: 600 }
  plugin_payment: { window_ms: 3600000, max: 30 }

roles:
  definitions:
    developer:   { level: 100, label: 开发者 }
    super_admin: { level: 90,  label: 超级管理员 }
    admin:       { level: 50,  label: 管理员 }
    user:        { level: 0,   label: 普通用户 }
  requestable: [super_admin, developer]
  promotion_cooldown_ms: 604800000
  grantable_by:
    developer:   [super_admin, admin, user]
    super_admin: [admin, user]
    admin:       []
    user:        []
  capabilities:
    view_audit: 50
    manage_apikeys: 50
    ban_user: 90
    grant_admin: 100

official_account:
  username: '__official__'
  nickname: 官方商城
  avatar: ''
  role: developer

# 支付系统（本次被测对象）
payments:
  transfer:
    min_amount: 1
    max_amount: 10000
    daily_limit: 500000
    expire_hours: 24
    note_max_len: 50
  redpacket:
    min_amount_per_pack: 1
    max_amount: 10000
    max_count: 100
    expire_hours: 24
    note_max_len: 20
  rate_limit:
    window_ms: 60000
    max: 1000
`, 'utf8');
  return cfgPath;
}

function startServer(cfgPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js'], {
      cwd: PROC_ROOT,
      env: {
        ...process.env,
        APP_CONFIG: cfgPath,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        SERVE_CLIENT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => process.stdout.write(`[srv] ${c}`));
    child.stderr.on('data', (c) => process.stderr.write(`[srv] ${c}`));
    child.on('error', reject);

    const deadline = Date.now() + 20000;
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${BASE}/health`);
          if (r.ok) return resolve(child);
        } catch { /* 还没就绪 */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('服务启动超时'));
    })();
  });
}

// ────────────────────────────────────────────────────────
// 直接操作临时 DB 的辅助
// ────────────────────────────────────────────────────────
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

function getBalance(db, userId) {
  const r = db.prepare('SELECT balance FROM user_points WHERE user_id = ?').get(userId);
  return r ? r.balance : 0;
}

function officialId(db) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get('__official__');
  return r ? r.id : null;
}

// ────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────
async function main() {
  console.log('=== payments_check ===\n');
  console.log(`临时目录：${TMP_ROOT}`);
  console.log(`端口：${PORT}\n`);

  const cfgPath = writeConfig();
  let server = null;
  try {
    server = await startServer(cfgPath);
    console.log(`服务已就绪：${BASE}\n`);

    // ────────────────────────────────────────────────────
    // [FIX] 记录官方账户**初始余额**作为 baseline。
    //   seed.js 会给 __official__ 也开 user_points（带 signup_points），
    //   所以 §11 的托管对账必须比较"跑测试前后的增量"，而不是绝对值。
    // ────────────────────────────────────────────────────
    const officialBaseline = withDb((db) => getBalance(db, officialId(db)));
    console.log(`官方账户初始余额（baseline）：${officialBaseline}\n`);

    // ────────────────────────────────────────────────────
    // 1. 准备账号
    // ────────────────────────────────────────────────────
    console.log('--- 1. 准备账号 ---');
    const tag = Date.now().toString(36);
    const users = [];
    for (let i = 1; i <= 3; i++) {
      const u = `pay_u${i}_${tag}`;
      const r = await api('POST', '/api/auth/register', {
        body: { username: u, password: 'test123456', nickname: `用户${i}` }
      });
      ok(r.status === 200 && r.data?.token, `注册 ${u}`);
      users.push({
        username: u,
        id: r.data.user.id,
        token: r.data.token,
        nickname: `用户${i}`
      });
    }
    const [A, B, C] = users;

    // ────────────────────────────────────────────────────
    // 2. 转账：发起 / 收款
    // ────────────────────────────────────────────────────
    console.log('\n--- 2. 转账：发起 / 收款 ---');
    {
      const beforeA = withDb((db) => getBalance(db, A.id));
      const beforeB = withDb((db) => getBalance(db, B.id));
      const beforeOff = withDb((db) => getBalance(db, officialId(db)));

      const r = await api('POST', '/api/transfers', {
        token: A.token,
        body: { toUserId: B.id, amount: 100, note: '测试' }
      });
      eq(r.status, 201, '发起转账 → 201');
      ok(!!r.data?.transfer?.id, '返回里带 transfer.id');
      const tid = r.data.transfer.id;

      const midA = withDb((db) => getBalance(db, A.id));
      const midB = withDb((db) => getBalance(db, B.id));
      const midOff = withDb((db) => getBalance(db, officialId(db)));

      eq(midA, beforeA - 100, 'A 余额 -100（立即扣款）');
      eq(midB, beforeB, 'B 余额未变（pending）');
      eq(midOff, beforeOff + 100, '官方托管 +100');

      const r2 = await api('POST', `/api/transfers/${tid}/accept`, { token: B.token });
      eq(r2.status, 200, 'B 收款 → 200');

      const finalA = withDb((db) => getBalance(db, A.id));
      const finalB = withDb((db) => getBalance(db, B.id));
      const finalOff = withDb((db) => getBalance(db, officialId(db)));

      eq(finalA, beforeA - 100, '收款后 A 保持 -100');
      eq(finalB, beforeB + 100, '收款后 B 余额 +100');
      eq(finalOff, beforeOff, '收款后官方托管归位');
    }

    // ────────────────────────────────────────────────────
    // 3. 转账：退还
    // ────────────────────────────────────────────────────
    console.log('\n--- 3. 转账：退还 ---');
    {
      const beforeA = withDb((db) => getBalance(db, A.id));
      const r = await api('POST', '/api/transfers', {
        token: A.token,
        body: { toUserId: C.id, amount: 50, note: '退还测试' }
      });
      const tid = r.data.transfer.id;
      const midA = withDb((db) => getBalance(db, A.id));
      eq(midA, beforeA - 50, '发出后 A 余额 -50');

      const r2 = await api('POST', `/api/transfers/${tid}/reject`, { token: C.token });
      eq(r2.status, 200, 'C 退还 → 200');
      const afterA = withDb((db) => getBalance(db, A.id));
      eq(afterA, beforeA, '退还后 A 余额恢复');
    }

    // ────────────────────────────────────────────────────
    // 4. 转账边界
    // ────────────────────────────────────────────────────
    console.log('\n--- 4. 转账边界 ---');
    {
      const r1 = await api('POST', '/api/transfers', {
        token: A.token, body: { toUserId: A.id, amount: 1 }
      });
      eq(r1.status, 400, '给自己转账 → 400');

      const r2 = await api('POST', '/api/transfers', {
        token: A.token, body: { toUserId: B.id, amount: 0 }
      });
      eq(r2.status, 400, '金额 0 → 400');

      const r3 = await api('POST', '/api/transfers', {
        token: A.token, body: { toUserId: B.id, amount: 99999999 }
      });
      eq(r3.status, 400, '金额超上限 → 400');

      const r4 = await api('POST', '/api/transfers', {
        token: A.token, body: { toUserId: 999999, amount: 10 }
      });
      eq(r4.status, 404, '收款人不存在 → 404');
    }

    // ────────────────────────────────────────────────────
    // 5. 建群（直接写库，跳过好友校验）
    // ────────────────────────────────────────────────────
    console.log('\n--- 5. 建群 ---');
    let groupId;
    {
      withDb((db) => {
        const now = Date.now();
        const info = db.prepare(
          'INSERT INTO groups (name, avatar, owner_id, created_at) VALUES (?, ?, ?, ?)'
        ).run('测试群', '', A.id, now);
        groupId = Number(info.lastInsertRowid);
        const ins = db.prepare(
          'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        );
        ins.run(groupId, A.id, 'owner', now);
        ins.run(groupId, B.id, 'member', now);
        ins.run(groupId, C.id, 'member', now);
      });
      ok(groupId > 0, `建群 id=${groupId}`);
    }
    const roomId = `g_${groupId}`;

    // ────────────────────────────────────────────────────
    // 6. 红包：拼手气
    // ────────────────────────────────────────────────────
    console.log('\n--- 6. 红包：拼手气 ---');
    {
      const beforeA = withDb((db) => getBalance(db, A.id));
      const beforeOff = withDb((db) => getBalance(db, officialId(db)));

      const r = await api('POST', '/api/redpackets', {
        token: A.token,
        body: {
          roomType: 'group', roomId,
          totalAmount: 300, count: 3, mode: 'lucky', note: '恭喜发财'
        }
      });
      eq(r.status, 201, '发拼手气红包 300/3 → 201');
      const rpid = r.data.redPacket.id;

      const afterA = withDb((db) => getBalance(db, A.id));
      const afterOff = withDb((db) => getBalance(db, officialId(db)));
      eq(afterA, beforeA - 300, 'A 余额 -300');
      eq(afterOff, beforeOff + 300, '官方托管 +300');

      const rB = await api('POST', `/api/redpackets/${rpid}/grab`, { token: B.token });
      eq(rB.status, 200, 'B 抢 → 200');
      ok(rB.data.amount > 0, `B 抢到 ${rB.data.amount} 积分`);

      const rB2 = await api('POST', `/api/redpackets/${rpid}/grab`, { token: B.token });
      eq(rB2.status, 400, 'B 重复抢 → 400');

      const rC = await api('POST', `/api/redpackets/${rpid}/grab`, { token: C.token });
      eq(rC.status, 200, 'C 抢 → 200');

      const rA = await api('POST', `/api/redpackets/${rpid}/grab`, { token: A.token });
      eq(rA.status, 400, '发送者自己抢 → 400');

      const detail = await api('GET', `/api/redpackets/${rpid}`, { token: A.token });
      const remain = detail.data.redPacket.remainingAmount;
      eq(rB.data.amount + rC.data.amount + remain, 300, '已抢 + 剩余 == 总额');
      eq(detail.data.redPacket.remainingCount, 1, '剩余 1 份');
      eq(detail.data.redPacket.status, 'active', '红包仍在进行');
    }

    // ────────────────────────────────────────────────────
    // 7. 红包：固定 + 抢完
    // ────────────────────────────────────────────────────
    console.log('\n--- 7. 红包：固定 ---');
    {
      const r = await api('POST', '/api/redpackets', {
        token: A.token,
        body: { roomType: 'group', roomId, totalAmount: 300, count: 3, mode: 'fixed' }
      });
      const rpid = r.data.redPacket.id;

      const rB = await api('POST', `/api/redpackets/${rpid}/grab`, { token: B.token });
      eq(rB.status, 200, 'B 抢 → 200');
      eq(rB.data.amount, 100, '固定红包每人 100（B）');

      const rC = await api('POST', `/api/redpackets/${rpid}/grab`, { token: C.token });
      eq(rC.data.amount, 100, '固定红包每人 100（C）');

      const detail = await api('GET', `/api/redpackets/${rpid}`, { token: A.token });
      eq(detail.data.redPacket.remainingCount, 1, '还剩 1 份');
      eq(detail.data.redPacket.remainingAmount, 100, '剩余金额 100');
    }

    // ────────────────────────────────────────────────────
    // 8. 红包边界
    // ────────────────────────────────────────────────────
    console.log('\n--- 8. 红包边界 ---');
    {
      const r1 = await api('POST', '/api/redpackets', {
        token: A.token,
        body: { roomType: 'group', roomId, totalAmount: 0, count: 1 }
      });
      eq(r1.status, 400, '总额 0 → 400');

      const r2 = await api('POST', '/api/redpackets', {
        token: A.token,
        body: { roomType: 'group', roomId, totalAmount: 10, count: 100 }
      });
      eq(r2.status, 400, '总额不足以分 100 份 → 400');

      // 非群成员抢
      const outsider = await api('POST', '/api/auth/register', {
        body: { username: `pay_x_${tag}`, password: 'test123456', nickname: '外部' }
      });
      const r3 = await api('POST', '/api/redpackets', {
        token: A.token,
        body: { roomType: 'group', roomId, totalAmount: 100, count: 1 }
      });
      const rpid = r3.data.redPacket.id;
      const r4 = await api('POST', `/api/redpackets/${rpid}/grab`, {
        token: outsider.data.token
      });
      eq(r4.status, 403, '非群成员抢 → 403');
    }

    // ────────────────────────────────────────────────────
    // 9. 私聊红包
    // ────────────────────────────────────────────────────
    console.log('\n--- 9. 私聊红包 ---');
    {
      const [x, y] = [A.id, B.id].sort((a, b) => a - b);
      const privateRoom = `p_${x}_${y}`;

      const r = await api('POST', '/api/redpackets', {
        token: A.token,
        body: {
          roomType: 'private', roomId: privateRoom,
          totalAmount: 50, count: 1, mode: 'fixed'
        }
      });
      eq(r.status, 201, '私聊红包 50/1 → 201');
      const rpid = r.data.redPacket.id;

      const rB = await api('POST', `/api/redpackets/${rpid}/grab`, { token: B.token });
      eq(rB.status, 200, 'B 抢 → 200');
      eq(rB.data.amount, 50, 'B 得 50');

      const r2 = await api('POST', '/api/redpackets', {
        token: A.token,
        body: {
          roomType: 'private', roomId: privateRoom,
          totalAmount: 100, count: 3
        }
      });
      eq(r2.status, 400, '私聊红包 count>1 → 400');
    }

    // ────────────────────────────────────────────────────
    // 10. 并发抢红包压测
    // ────────────────────────────────────────────────────
    console.log('\n--- 10. 并发抢红包：金额守恒 ---');
    {
      // 注册 10 个额外用户加入群
      const bulk = [];
      for (let i = 0; i < 10; i++) {
        const u = `pay_b${i}_${tag}`;
        const r = await api('POST', '/api/auth/register', {
          body: { username: u, password: 'test123456', nickname: `批量${i}` }
        });
        bulk.push({ id: r.data.user.id, token: r.data.token });
      }
      withDb((db) => {
        const ins = db.prepare(
          'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        );
        const now = Date.now();
        for (const u of bulk) ins.run(groupId, u.id, 'member', now);
      });

      const r = await api('POST', '/api/redpackets', {
        token: A.token,
        body: { roomType: 'group', roomId, totalAmount: 1000, count: 10, mode: 'lucky' }
      });
      const rpid = r.data.redPacket.id;

      // 10 人同时抢
      const results = await Promise.all(
        bulk.map((u) => api('POST', `/api/redpackets/${rpid}/grab`, { token: u.token }))
      );
      const okCount = results.filter((x) => x.status === 200).length;
      eq(okCount, 10, '10 个并发抢全部 200');

      const amounts = results.map((x) => x.data?.amount || 0);
      const sum = amounts.reduce((a, b) => a + b, 0);
      eq(sum, 1000, '10 人金额总和 == 总额 1000');

      // 检查没有负数或 0
      ok(amounts.every((a) => a >= 1), '每人至少 1 积分');

      const detail = await api('GET', `/api/redpackets/${rpid}`, { token: A.token });
      eq(detail.data.redPacket.status, 'empty', '红包状态 empty');
      eq(detail.data.redPacket.remainingCount, 0, '剩余 0 份');
      eq(detail.data.redPacket.remainingAmount, 0, '剩余金额 0');

      // 数据库层面二次确认：grants 之和 == 总额
      const dbSum = withDb((db) => {
        const r2 = db.prepare(
          'SELECT COALESCE(SUM(amount), 0) AS s FROM red_packet_grants WHERE red_packet_id = ?'
        ).get(rpid);
        return r2.s;
      });
      eq(dbSum, 1000, '数据库 grants 之和 == 1000');
    }

    // ────────────────────────────────────────────────────
    // 11. 托管对账（比较官方账户**增量**，不是绝对值）
    // ────────────────────────────────────────────────────
    console.log('\n--- 11. 托管对账 ---');
    {
      const rec = withDb((db) => {
        const offId = officialId(db);
        const offBalance = getBalance(db, offId);
        const pendingT = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE status = 'pending'`
        ).get().total;
        const activeRp = db.prepare(
          `SELECT COALESCE(SUM(remaining_amount), 0) AS total
             FROM red_packets WHERE status = 'active'`
        ).get().total;
        return { offBalance, pendingT, activeRp };
      });

      // [FIX] __official__ 在 seed 时也带 signup_points 初始余额，
      //       所以只能比较"跑测试前后的增量"。
      const delta = rec.offBalance - officialBaseline;
      const expected = rec.pendingT + rec.activeRp;
      eq(
        delta,
        expected,
        `官方托管增量 ${delta} == pending 转账 ${rec.pendingT} + active 红包剩余 ${rec.activeRp}（baseline ${officialBaseline}）`
      );
    }

    // ────────────────────────────────────────────────────
    // 完成
    // ────────────────────────────────────────────────────
    console.log('\n=== 完成 ===');
    console.log(`通过：${passed}  失败：${failed}`);
    if (failed > 0) {
      console.log('\n失败列表：');
      for (const f of failures) console.log(`  · ${f}`);
    }
  } finally {
    if (server) {
      try { server.kill('SIGTERM'); } catch { /* ignore */ }
      // Windows 上 SIGTERM 不一定立即生效，稍等再 SIGKILL
      await new Promise((r) => setTimeout(r, 500));
      try { server.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n临时目录已清理：${TMP_ROOT}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});