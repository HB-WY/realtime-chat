// scripts/room_icon_check.mjs
//
// 端到端自检：公共聊天图标（仅开发者）+ 群图标（群主 / 群管理员）。
//
// 用法：先启动服务（node index.js），再执行
//   node scripts/room_icon_check.mjs            # 跑完自动删掉本套测试账号
//   node scripts/room_icon_check.mjs --keep     # 保留测试账号，便于事后排查
//
// 覆盖点：
//   1) room_settings 的读写与权限（普通用户 403 / 开发者 200 / 非法输入被净化）
//   2) 群图标：群主可改、群管理员可改、普通成员与非成员 403、群名仍只有群主可改
//   3) 群主任免群管理员；被取消后立即失去改图标权限
//   4) socket state:init 带 publicRoom、GET /api/groups 带 avatar
//   5) /api/v1 前缀只认 API 密钥（JWT 访问 401）
//
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTestAccounts, snapshotUploads, cleanupRunUploads } from './lib/cleanup_accounts.mjs';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'chat.db');

const TS = Date.now().toString().slice(-7);

let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

function section(t) {
  console.log(`\n\x1b[36m${t}\x1b[0m`);
}

async function api(pathname, { method = 'GET', token, key, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-API-Key'] = key;

  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, data, raw: text.slice(0, 200) };
}

const main = async () => {
  // 收尾要用的「跑之前 uploads/ 长什么样」快照（只清本次新增的无主文件）
  const uploadsBefore = snapshotUploads();
  const users = {};
  let publicRoomBefore = null;

  // ============================================================
  section('0. 准备账号');
  for (const who of ['dev', 'owner', 'mem']) {
    const username = `ric_${TS}_${who}`;
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password: 'pass1234', nickname: `图标${who}` }
    });
    users[who] = { username, token: r.data?.token, id: r.data?.user?.id };
    ok(r.status === 200 && !!r.data?.token, `注册 ${username}`);
  }

  // 把 dev 提升为 developer（直接改库，等价于「开发者」）
  {
    const db = new DatabaseSync(DB_PATH);
    db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(users.dev.id);
    // [FIX] 先记下公共聊天图标的**原值**：本套测试会改它，收尾必须还原而不是删行，
    //       否则会把使用者在管理端设置的图标清空。
    publicRoomBefore = db.prepare('SELECT * FROM room_settings WHERE room_key = ?').get('public') || null;
    db.close();
  }
  {
    const me = await api('/api/auth/me', { token: users.dev.token });
    ok(me.data?.user?.role === 'developer', 'dev 已是 developer');
  }

  // owner 与 mem 加好友（创建群时只能邀请好友）
  {
    const req = await api('/api/friends/requests', {
      method: 'POST', token: users.owner.token, body: { username: users.mem.username }
    });
    const accept = await api(`/api/friends/requests/${req.data?.id}/accept`, {
      method: 'POST', token: users.mem.token
    });
    ok(req.status === 200 && accept.status === 200, 'owner ↔ mem 成为好友');
  }

  // ============================================================
  section('1. 公共聊天图标（能力位 manage_public_room）');

  {
    const r = await api('/api/rooms/public', { token: users.mem.token });
    ok(r.status === 200, 'GET /api/rooms/public 200');
    ok(r.data?.roomKey === 'public' && r.data?.name === '公共聊天', '返回公共聊天房信息', r.data);
    ok(typeof r.data?.icon === 'string', 'icon 字段存在（可为空串）', r.data?.icon);
  }

  {
    const denied = await api('/api/rooms/public/icon', {
      method: 'PUT', token: users.mem.token, body: { icon: '🐱' }
    });
    ok(denied.status === 403, '普通用户改公共聊天图标 → 403', denied);
  }

  {
    const set = await api('/api/rooms/public/icon', {
      method: 'PUT', token: users.dev.token, body: { icon: '🎯' }
    });
    ok(set.status === 200 && set.data?.room?.icon === '🎯', '开发者设为 emoji', set.data);
    ok(set.data?.room?.updatedBy === users.dev.id, '记录操作者 updatedBy', set.data?.room);
  }

  {
    const seen = await api('/api/rooms/public', { token: users.mem.token });
    ok(seen.data?.icon === '🎯', '其他用户立刻读到新图标', seen.data);
  }

  {
    const url = await api('/api/rooms/public/icon', {
      method: 'PUT', token: users.dev.token, body: { icon: '/uploads/avatars/room_icon_test.png' }
    });
    ok(url.data?.room?.icon === '/uploads/avatars/room_icon_test.png', '开发者可设为上传图片 URL', url.data);

    const sneaky = await api('/api/rooms/public/icon', {
      method: 'PUT', token: users.dev.token, body: { icon: 'javascript:alert(1)' }
    });
    ok(sneaky.status === 200, '奇怪字符串不 500', sneaky);
    ok(!/javascript/i.test(sneaky.data?.room?.icon || ''), 'javascript: 注入被净化（只取首字符）', sneaky.data?.room?.icon);
  }

  {
    const noAuth = await api('/api/rooms/public');
    ok(noAuth.status === 401, '未登录读公共聊天房 → 401', noAuth.status);

    const noKey = await api('/api/v1/rooms/public', { token: users.dev.token });
    ok(noKey.status === 401, '/api/v1/* 带 JWT → 401（只认密钥）', noKey.status);
  }

  // ============================================================
  section('2. 群图标：群主 / 群管理员');

  let groupId = null;
  {
    const g = await api('/api/groups', {
      method: 'POST', token: users.owner.token,
      body: { name: `图标群${TS}`, memberIds: [users.mem.id] }
    });
    groupId = g.data?.groupId;
    ok(g.status === 200 && !!groupId, 'owner 创建群并拉入 mem', g.data);
  }

  {
    const info = await api(`/api/groups/${groupId}`, { token: users.owner.token });
    ok(info.data?.group?.myRole === 'owner', '群主看到 myRole=owner', info.data?.group?.myRole);
    ok(info.data?.group?.canEditIcon === true, '群主 canEditIcon=true');
  }

  {
    const info = await api(`/api/groups/${groupId}`, { token: users.mem.token });
    ok(info.data?.group?.myRole === 'member', '成员看到 myRole=member', info.data?.group?.myRole);
    ok(info.data?.group?.canEditIcon === false, '普通成员 canEditIcon=false');
  }

  {
    const byOwner = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.owner.token, body: { avatar: '🦊' }
    });
    ok(byOwner.status === 200 && byOwner.data?.group?.avatar === '🦊', '群主设置群图标', byOwner.data?.group?.avatar);
  }

  {
    const byMember = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.mem.token, body: { avatar: '🐼' }
    });
    ok(byMember.status === 403, '普通成员改群图标 → 403', byMember);
  }

  {
    const byOutsider = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.dev.token, body: { avatar: '🐼' }
    });
    ok(byOutsider.status === 403, '非群成员（哪怕是开发者）改群图标 → 403', byOutsider);
  }

  // ============================================================
  section('3. 任免群管理员（仅群主）');

  {
    const byMember = await api(`/api/groups/${groupId}/members/${users.owner.id}/role`, {
      method: 'POST', token: users.mem.token, body: { role: 'admin' }
    });
    ok(byMember.status === 403, '普通成员无权任免管理员 → 403', byMember);
  }

  {
    const bad = await api(`/api/groups/${groupId}/members/${users.mem.id}/role`, {
      method: 'POST', token: users.owner.token, body: { role: 'owner' }
    });
    ok(bad.status === 400, 'role 只接受 admin / member → 400', bad);
  }

  {
    const up = await api(`/api/groups/${groupId}/members/${users.mem.id}/role`, {
      method: 'POST', token: users.owner.token, body: { role: 'admin' }
    });
    ok(up.status === 200, '群主把 mem 设为管理员', up.data);
    const admin = up.data?.group?.members?.find((m) => m.id === users.mem.id);
    ok(admin?.role === 'admin', '成员身份已变更为 admin', admin);
    ok(up.data?.group?.members?.[1]?.role === 'admin', '成员列表按 群主→管理员→成员 排序', up.data?.group?.members?.map((m) => m.role));
  }

  {
    const info = await api(`/api/groups/${groupId}`, { token: users.mem.token });
    ok(info.data?.group?.myRole === 'admin', 'mem 看到 myRole=admin');
    ok(info.data?.group?.canEditIcon === true, '群管理员 canEditIcon=true');

    const set = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.mem.token, body: { avatar: '/uploads/avatars/group_icon_test.png' }
    });
    ok(set.status === 200 && set.data?.group?.avatar === '/uploads/avatars/group_icon_test.png',
      '群管理员也能设置群图标', set.data?.group?.avatar);

    const rename = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.mem.token, body: { name: '管理员想改群名' }
    });
    ok(rename.status === 403, '群管理员仍不能改群名 → 403', rename);
  }

  {
    const down = await api(`/api/groups/${groupId}/members/${users.mem.id}/role`, {
      method: 'POST', token: users.owner.token, body: { role: 'member' }
    });
    ok(down.status === 200, '群主取消 mem 的管理员身份');

    const after = await api(`/api/groups/${groupId}`, {
      method: 'PATCH', token: users.mem.token, body: { avatar: '🐵' }
    });
    ok(after.status === 403, '被取消后立刻失去改图标权限 → 403', after);
  }

  // ============================================================
  section('4. 图标随群列表下发');

  {
    const list = await api('/api/groups', { token: users.mem.token });
    const g = list.data?.groups?.find((x) => x.id === groupId);
    ok(!!g, 'mem 的群列表里有该群');
    ok(g?.avatar === '/uploads/avatars/group_icon_test.png', '群列表带最新的群图标', g?.avatar);
  }

  // ============================================================
  section('5. 清理测试数据');

  {
    // [FIX] 还原公共聊天图标：测试前有值就恢复原值；测试前本来没有才留空。
    //       （原先固定置空 + 删行，会把使用者真实设置的图标一起清掉。）
    if (publicRoomBefore) {
      const restore = await api('/api/rooms/public/icon', {
        method: 'PUT', token: users.dev.token, body: { icon: publicRoomBefore.icon }
      });
      ok(restore.status === 200 && restore.data?.room?.icon === publicRoomBefore.icon,
        '公共聊天图标已恢复为测试前的原值');
    } else {
      const reset = await api('/api/rooms/public/icon', {
        method: 'PUT', token: users.dev.token, body: { icon: '' }
      });
      ok(reset.status === 200 && reset.data?.room?.icon === '', '公共聊天图标已恢复为空');
    }

    // 群主退群 = 解散
    const diss = await api(`/api/groups/${groupId}/members/me`, {
      method: 'DELETE', token: users.owner.token
    });
    ok(diss.status === 200 && diss.data?.dissolved === true, '测试群已解散');

    const db = new DatabaseSync(DB_PATH);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(users.dev.id);
    // 只有测试前不存在该行时才删（否则保留上面恢复的原值）
    if (!publicRoomBefore) db.prepare('DELETE FROM room_settings WHERE room_key = ?').run('public');
    db.close();
    ok(true, `已把 dev 降回 user、还原 room_settings（${publicRoomBefore ? '原值' : '测试写入已清除'}）`);
  }

  // [收尾] 删掉本套 ric_ 测试账号（连同名下数据与上传文件）。
  // 跑在真实库上，不收尾就会一轮一轮沉淀（ERRORLOG TEST-1 / DEVLOG §1.74）。
  // 想保留现场：node scripts/room_icon_check.mjs --keep
  cleanupTestAccounts([users.dev?.id, users.owner?.id, users.mem?.id]);
  cleanupRunUploads(uploadsBefore);

  console.log(`\n结果: \x1b[32m${passed} 通过\x1b[0m / ${failed ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'}`);
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error('\n[room_icon_check] 异常：', err);
  process.exit(1);
});
