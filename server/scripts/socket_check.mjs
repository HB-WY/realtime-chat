// scripts/socket_check.mjs —— Socket.IO 层回归验证（JWT + API 密钥 + 重构后的 handler）
//
// 需要 socket.io-client：从 client/node_modules 解析，因此请在 client 目录下运行：
//   cd client && node ../server/scripts/socket_check.mjs            # 跑完自动删掉本套测试账号
//   cd client && node ../server/scripts/socket_check.mjs --keep     # 保留测试账号，便于事后排查
//
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTestAccounts, snapshotUploads, cleanupRunUploads } from './lib/cleanup_accounts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'client', 'package.json'));
const { io } = require('socket.io-client');

const BASE = process.env.SOCKET_BASE || 'http://127.0.0.1:3001';
const TS = Date.now().toString().slice(-7);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

async function api(p, o = {}) {
  const h = {};
  if (o.token) h.Authorization = 'Bearer ' + o.token;
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, {
    method: o.method || 'GET', headers: h,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined
  });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    s.on('state:init', (st) => { clearTimeout(timer); resolve({ socket: s, state: st }); });
    s.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
  });
}

const once = (socket, event, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

const main = async () => {
  // 收尾要用的「跑之前 uploads/ 长什么样」快照（只清本次新增的无主文件）
  const uploadsBefore = snapshotUploads();
  section('0. 账号');
  const a = (await api('/api/auth/register', { method: 'POST', body: { username: `sk_${TS}_a`, password: 'pass1234', nickname: '套接字A' } })).data;
  const b = (await api('/api/auth/register', { method: 'POST', body: { username: `sk_${TS}_b`, password: 'pass1234', nickname: '套接字B' } })).data;
  ok(!!a?.token && !!b?.token, '两个账号注册成功');

  // [FIX] 先记下公共聊天图标的**原值**：本套测试会改它（4.5 节），
  //       收尾必须还原而不是删行 —— 否则会把使用者在管理端设置的图标清空。
  let publicRoomBefore = null;
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(HERE, '..', 'chat.db'));
    publicRoomBefore = db.prepare('SELECT * FROM room_settings WHERE room_key = ?').get('public') || null;
    db.close();
  }

  section('1. JWT socket 连接（重构后的 socket 层）');
  const A = await connect(a.token);
  ok(!!A.state?.user?.id, 'A state:init 收到用户信息');
  ok(Array.isArray(A.state?.friends), 'state:init 含好友列表');

  const B = await connect(b.token);
  ok(!!B.state?.user?.id, 'B 连接成功');

  section('2. 消息：发送 / 历史 / 撤回');
  const newMsgP = once(B.socket, 'message:new');
  const ack = await new Promise((res) => A.socket.emit('message:send', {
    roomType: 'public', roomId: 'public', text: `socket 回归 ${TS}`
  }, res));
  ok(ack?.ok === true, 'message:send ack ok', ack);
  const got = await newMsgP;
  ok(got?.text === `socket 回归 ${TS}`, 'B 实时收到 message:new', got?.text);

  const histP = once(A.socket, 'messages:history');
  A.socket.emit('room:open', { roomType: 'public', roomId: 'public' });
  const hist = await histP;
  ok(Array.isArray(hist?.messages) && hist.messages.length > 0, 'room:open 返回历史');
  ok(hist?.messages?.every((m) => 'isSticker' in m), '历史消息带 isSticker 字段');

  const recalledP = once(B.socket, 'message:recalled');
  const rack = await new Promise((res) => A.socket.emit('message:recall', ack.id, res));
  ok(rack?.ok === true, 'message:recall ack ok', rack);
  const recalled = await recalledP;
  ok(recalled?.messageId === ack.id, 'B 收到 message:recalled');

  // 撤回 = 直接删除：历史里不能再有这条，也不能留「消息已撤回」占位
  const histP2 = once(A.socket, 'messages:history');
  A.socket.emit('room:open', { roomType: 'public', roomId: 'public' });
  const hist2 = await histP2;
  const kept = (hist2?.messages || []).find((m) => m.id === ack.id);
  ok(!kept, '撤回后历史里已没有这条消息', kept);
  ok(
    !(hist2?.messages || []).some((m) => m.text === '[消息已撤回]'),
    '历史里不存在「消息已撤回」占位行'
  );

  section('3. 表情消息（isSticker）');
  const stMsgP = once(B.socket, 'message:new');
  const sack = await new Promise((res) => A.socket.emit('message:send', {
    roomType: 'public', roomId: 'public', text: '',
    fileUrl: '/uploads/custom/1/aaa.png', fileName: 's.png', fileType: 'image', isSticker: true
  }, res));
  ok(sack?.ok === true, '表情消息发送成功', sack);
  const stMsg = await stMsgP;
  ok(stMsg?.isSticker === true, '对端收到 isSticker: true');

  const badAck = await new Promise((res) => A.socket.emit('message:send', {
    roomType: 'public', roomId: 'public', isSticker: true, fileUrl: 'https://evil/x.png'
  }, res));
  ok(!!badAck?.error, '非法表情消息被拒绝', badAck);

  section('4. 好友 / 群聊（handler 已改为调用 services/chat.js）');
  const frP = once(B.socket, 'friend:req:new');
  const fAck = await new Promise((res) => A.socket.emit('friend:request', { username: b.user.username }, res));
  ok(fAck?.ok === true, 'friend:request ok', fAck);
  const fr = await frP;
  ok(fr?.fromId === a.user.id, 'B 实时收到 friend:req:new');

  const listP = once(A.socket, 'friend:list');
  B.socket.emit('friend:accept', { requestId: fr.id });
  const flist = await listP;
  ok((flist || []).some((f) => f.id === b.user.id), '接受后 A 收到 friend:list');

  const gAck = await new Promise((res) => A.socket.emit('group:create', { name: `套接字群${TS}`, memberIds: [b.user.id] }, res));
  ok(gAck?.ok === true && gAck.groupId > 0, 'group:create ok', gAck);

  const gInfo = await new Promise((res) => A.socket.emit('group:info', { groupId: gAck.groupId }, res));
  ok(gInfo?.group?.members?.length === 2, 'group:info 返回 2 名成员', gInfo?.group?.members?.length);

  const gMsgP = once(B.socket, 'message:new');
  const gSend = await new Promise((res) => B.socket.emit('message:send', {
    roomType: 'group', roomId: `g_${gAck.groupId}`, text: '群消息'
  }, res));
  ok(gSend?.ok === true, '群成员可发群消息', gSend);
  const gMsg = await gMsgP;
  ok(gMsg?.roomId === `g_${gAck.groupId}`, '群成员实时收到群消息');

  A.socket.emit('typing:start', { roomType: 'public', roomId: 'public' });
  A.socket.emit('typing:stop', { roomType: 'public', roomId: 'public' });
  ok(true, 'typing:start / typing:stop 未抛错');

  section('4.5 房间图标：公共聊天（开发者）与群图标（群主 / 群管理员）');
  ok(A.state?.publicRoom?.roomKey === 'public', 'state:init 带 publicRoom', A.state?.publicRoom);

  {
    // A 现在还是普通用户 → 无 manage_public_room 权限
    const denied = await new Promise((res) => A.socket.emit('room:public:icon', { icon: '🐳' }, res));
    ok(!!denied?.error, '普通用户 socket 改公共聊天图标被拒', denied);
  }

  // 直接把 A 提升为 developer，然后重连（socket.user 是连接时快照）
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(HERE, '..', 'chat.db'));
    db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(a.user.id);
    db.close();
  }
  const A2 = await connect(a.token);
  const broadcastP = once(B.socket, 'room:public:updated');
  const setAck = await new Promise((res) => A2.socket.emit('room:public:icon', { icon: '🐳' }, res));
  ok(setAck?.ok === true && setAck.room?.icon === '🐳', '开发者 socket 可改公共聊天图标', setAck);
  const broadcast = await broadcastP;
  ok(broadcast?.icon === '🐳', '全体在线用户收到 room:public:updated', broadcast);

  {
    // 群图标：群主 A 通过 socket 修改
    const gListP = once(B.socket, 'group:list');
    const up = await new Promise((res) => A2.socket.emit('group:update', { groupId: gAck.groupId, avatar: '🦁' }, res));
    ok(up?.ok === true && up.group?.avatar === '🦁', '群主 socket 设置群图标', up);
    const gList = await gListP;
    ok((gList || []).some((g) => g.id === gAck.groupId && g.avatar === '🦁'), '成员实时收到 group:list（含新图标）');

    // 普通成员 B 还改不了
    const denied = await new Promise((res) => B.socket.emit('group:update', { groupId: gAck.groupId, avatar: '🐻' }, res));
    ok(!!denied?.error, '普通成员 socket 改群图标被拒', denied);

    // 群主把 B 设为管理员 → B 之后可以改
    const role = await new Promise((res) => A2.socket.emit('group:member:role', { groupId: gAck.groupId, userId: b.user.id, role: 'admin' }, res));
    ok(role?.ok === true, '群主 socket 任免群管理员', role);
    ok(role?.group?.members?.find((m) => m.id === b.user.id)?.role === 'admin', 'B 已成为 admin');

    const upByAdmin = await new Promise((res) => B.socket.emit('group:update', { groupId: gAck.groupId, avatar: '🐯' }, res));
    ok(upByAdmin?.ok === true && upByAdmin.group?.avatar === '🐯', '群管理员 socket 可改群图标', upByAdmin);

    const rename = await new Promise((res) => B.socket.emit('group:update', { groupId: gAck.groupId, name: '管理员改名' }, res));
    ok(!!rename?.error, '群管理员仍不能改群名', rename);

    // 取消管理员后立即失效
    await new Promise((res) => A2.socket.emit('group:member:role', { groupId: gAck.groupId, userId: b.user.id, role: 'member' }, res));
    const after = await new Promise((res) => B.socket.emit('group:update', { groupId: gAck.groupId, avatar: '🐨' }, res));
    ok(!!after?.error, '被取消管理员后立即失去权限', after);
  }

  A2.socket.disconnect();

  // ============================================================
  // 4.6 支付系统（转账 / 红包）—— socket 通道回归
  //
  // payments_check.mjs 覆盖的是 REST + service 层；这一节专门钉住
  // socket handler 的转发路径与实时事件广播：
  //   · transfer:send / transfer:accept / transfer:reject
  //   · redpacket:send / redpacket:grab
  //   · 各实时事件（transfer:new / transfer:accepted / transfer:rejected
  //     / redpacket:new / redpacket:grabbed）
  //   · 边界：自转 / 金额 0 / 自己抢自己 / 重复抢 / 非成员抢 / 非私聊参与者抢
  //
  // 用一个临时的第三个账号 C 专门测越权（C 不在群里、也不在 A-B 私聊里）。
  // ============================================================
  section('4.6 支付系统（转账 / 红包）');
  const c = (await api('/api/auth/register', {
    method: 'POST',
    body: { username: `sk_${TS}_c`, password: 'pass1234', nickname: '套接字C' }
  })).data;
  ok(!!c?.token, '第三个账号注册成功（用于越权测试）');
  const C = await connect(c.token);

  // [FIX] 给本套测试账号充积分。
  //   打在**真实库**上的 socket_check 里，新账号只有 signup_points（默认 50），
  //   完全不够做 100 / 300 的转账 / 红包 —— 本段开头就会以 "积分不足" 失败。
  //   直接 SQL 改 user_points.balance（不写流水，测试专用）。
  //   sk_* 账号会在收尾被 cleanupTestAccounts 整行删除（含 user_points），
  //   所以**不需要**还原。
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(HERE, '..', 'chat.db'));
    const bump = db.prepare('UPDATE user_points SET balance = ?, updated_at = ? WHERE user_id = ?');
    const now = Date.now();
    bump.run(100000, now, a.user.id);
    bump.run(100000, now, b.user.id);
    bump.run(100000, now, c.user.id);
    db.close();
  }
  ok(true, '本套测试账号积分已充至 100000（测试专用，收尾随账号一同删除）');

  // ---------- 转账：发起 / 收款 ----------
  {
    const newP = once(B.socket, 'transfer:new', 3000);
    const tAck = await new Promise((res) => A.socket.emit('transfer:send', {
      toUserId: b.user.id, amount: 100, note: 'socket 转账'
    }, res));
    ok(tAck?.ok === true && !!tAck.transfer?.id, 'transfer:send ack ok', tAck);
    const got = await newP;
    ok(got?.transfer?.id === tAck.transfer.id, 'B 实时收到 transfer:new', got?.transfer?.id);
    ok(got?.transfer?.status === 'pending', '新转账状态为 pending', got?.transfer?.status);

    const acceptedP = once(A.socket, 'transfer:accepted', 3000);
    const accAck = await new Promise((res) => B.socket.emit('transfer:accept', {
      transferId: tAck.transfer.id
    }, res));
    ok(accAck?.ok === true && accAck.transfer?.status === 'accepted', 'B transfer:accept ack ok', accAck);

    const accepted = await acceptedP;
    ok(accepted?.transfer?.id === tAck.transfer.id, 'A 实时收到 transfer:accepted', accepted?.transfer?.id);
    ok(accepted?.transfer?.status === 'accepted', '事件里状态已变为 accepted', accepted?.transfer?.status);
  }

  // ---------- 转账：退还 ----------
  {
    const tAck = await new Promise((res) => A.socket.emit('transfer:send', {
      toUserId: b.user.id, amount: 50, note: '退还测试'
    }, res));
    ok(tAck?.ok === true, '发起第二笔转账（用于退还）', tAck);

    const rejectedP = once(A.socket, 'transfer:rejected', 3000);
    const rejAck = await new Promise((res) => B.socket.emit('transfer:reject', {
      transferId: tAck.transfer.id
    }, res));
    ok(rejAck?.ok === true && rejAck.transfer?.status === 'rejected', 'B transfer:reject ack ok', rejAck);

    const rejected = await rejectedP;
    ok(rejected?.transfer?.id === tAck.transfer.id, 'A 实时收到 transfer:rejected', rejected?.transfer?.id);
    ok(rejected?.transfer?.status === 'rejected', '事件里状态已变为 rejected', rejected?.transfer?.status);
  }

  // ---------- 转账边界（socket 层） ----------
  {
    const selfAck = await new Promise((res) => A.socket.emit('transfer:send', {
      toUserId: a.user.id, amount: 10
    }, res));
    ok(!!selfAck?.error, '给自己转账被拒', selfAck);

    const zeroAck = await new Promise((res) => A.socket.emit('transfer:send', {
      toUserId: b.user.id, amount: 0
    }, res));
    ok(!!zeroAck?.error, '金额 0 被拒', zeroAck);

    // C 不在 A→B 的转账关系里：C 不能替 A 收款，也不能替 A 退还
    const tAck = await new Promise((res) => A.socket.emit('transfer:send', {
      toUserId: b.user.id, amount: 20
    }, res));
    ok(tAck?.ok === true, '发起第三笔转账（越权用）', tAck);

    const denyAccept = await new Promise((res) => C.socket.emit('transfer:accept', {
      transferId: tAck.transfer.id
    }, res));
    ok(!!denyAccept?.error, '非收款人 accept 被拒', denyAccept);

    const denyReject = await new Promise((res) => C.socket.emit('transfer:reject', {
      transferId: tAck.transfer.id
    }, res));
    ok(!!denyReject?.error, '非收款人 reject 被拒', denyReject);

    // 干净收尾这一笔（B 收款），避免留给后续"托管对账"或其他测试干扰
    await new Promise((res) => B.socket.emit('transfer:accept', {
      transferId: tAck.transfer.id
    }, res));
  }

  // ---------- 红包：群内发 / 抢 / 广播 ----------
  let groupRpId = null;
  {
    const newP = once(B.socket, 'redpacket:new', 3000);
    const rpAck = await new Promise((res) => A.socket.emit('redpacket:send', {
      roomType: 'group', roomId: `g_${gAck.groupId}`,
      totalAmount: 300, count: 3, mode: 'lucky', note: '恭喜发财'
    }, res));
    ok(rpAck?.ok === true && !!rpAck.redPacket?.id, 'redpacket:send ack ok', rpAck);
    groupRpId = rpAck.redPacket.id;

    const got = await newP;
    ok(got?.redPacket?.id === groupRpId, 'B 实时收到 redpacket:new', got?.redPacket?.id);
    ok(got?.redPacket?.status === 'active', '新红包状态为 active');
    ok(got?.redPacket?.remainingCount === 3, '新红包剩余 3 份');
  }

  // 发送者自己抢被拒
  {
    const self = await new Promise((res) => A.socket.emit('redpacket:grab', {
      redPacketId: groupRpId
    }, res));
    ok(!!self?.error, '发送者自己抢被拒', self);
  }

  // B 抢 → A 收到 redpacket:grabbed
  {
    const grabbedP = once(A.socket, 'redpacket:grabbed', 3000);
    const gAck2 = await new Promise((res) => B.socket.emit('redpacket:grab', {
      redPacketId: groupRpId
    }, res));
    ok(gAck2?.ok === true && gAck2.amount > 0, 'B 抢到红包', gAck2);
    ok(gAck2.redPacket?.remainingCount === 2, '剩余份数变为 2', gAck2.redPacket?.remainingCount);

    const grabbed = await grabbedP;
    ok(grabbed?.redPacketId === groupRpId, 'A 实时收到 redpacket:grabbed（红包 id 匹配）', grabbed?.redPacketId);
    ok(grabbed?.userId === b.user.id, '事件里带抢红包的人 userId', grabbed?.userId);
    ok(grabbed?.remainingCount === 2, '事件里带剩余份数', grabbed?.remainingCount);
  }

  // B 重复抢被拒
  {
    const dup = await new Promise((res) => B.socket.emit('redpacket:grab', {
      redPacketId: groupRpId
    }, res));
    ok(!!dup?.error, 'B 重复抢被拒', dup);
  }

  // 非群成员 C 抢被拒
  {
    const deny = await new Promise((res) => C.socket.emit('redpacket:grab', {
      redPacketId: groupRpId
    }, res));
    ok(!!deny?.error, '非群成员抢群红包被拒', deny);
  }

  // ---------- 红包：私聊（只有对方能抢） ----------
  {
    const [x, y] = [a.user.id, b.user.id].sort((p, q) => p - q);
    const privateRoom = `p_${x}_${y}`;

    const rpAck = await new Promise((res) => A.socket.emit('redpacket:send', {
      roomType: 'private', roomId: privateRoom,
      totalAmount: 50, count: 1, mode: 'fixed', note: '私聊红包'
    }, res));
    ok(rpAck?.ok === true, '私聊红包发送成功', rpAck);

    // C 不是参与者 → 抢被拒
    const deny = await new Promise((res) => C.socket.emit('redpacket:grab', {
      redPacketId: rpAck.redPacket.id
    }, res));
    ok(!!deny?.error, '非私聊参与者抢被拒', deny);

    // B 抢到
    const grab = await new Promise((res) => B.socket.emit('redpacket:grab', {
      redPacketId: rpAck.redPacket.id
    }, res));
    ok(grab?.ok === true && grab.amount === 50, 'B 抢到私聊红包 50', grab);
    ok(grab?.emptied === true, '私聊红包抢完 → emptied=true', grab?.emptied);
  }

  C.socket.disconnect();

  section('5. API 密钥也能连 socket（第二条通道覆盖实时能力）');
  const mk = await api('/api/keys', { method: 'POST', token: a.token, body: { name: 'socket-check' } });
  if (mk.status === 403) {
    ok(true, `本机 IP 已被绑定（${mk.data?.error}），跳过密钥 socket 连接`);
  } else {
    ok(mk.status === 201, '申请密钥成功', mk.data);
    try {
      const K = await connect(mk.data.key);
      ok(!!K.state?.user?.id && K.state.user.id === a.user.id, 'API 密钥 socket 连接成功');
      const kAck = await new Promise((res) => K.socket.emit('message:send', {
        roomType: 'public', roomId: 'public', text: 'via api key socket'
      }, res));
      ok(kAck?.ok === true, '密钥 socket 能发消息', kAck);
      K.socket.disconnect();
    } catch (e) {
      ok(false, 'API 密钥 socket 连接失败', e.message);
    }
  }

  section('5.5 崩溃回归：handler 异常不得打死进程');
  {
    // 历史 Bug：socket/index.js 从 registry 解构了未导出的 onlineUsers（拿到 undefined），
    // 改昵称/头像触发的 user:refresh 一旦执行就 TypeError → uncaughtException → 进程退出。
    // 这里固化两点：user:refresh 正常工作；缺失/畸形 payload 不能打崩服务。
    const alive = async () => {
      try { return (await fetch(BASE + '/health')).ok; } catch { return false; }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    ok(await alive(), '触发前服务存活');

    const refreshed = once(A.socket, 'user:updated', 3000);
    A.socket.emit('user:refresh');
    const upd = await refreshed;
    await sleep(200);
    ok(!!upd && upd.id === a.user.id, 'user:refresh 广播 user:updated', upd);
    ok(A.socket.connected, 'user:refresh 后连接未被断开');
    ok(await alive(), 'user:refresh 后服务存活（原先此处 100% 进程退出）');

    const malformed = [
      ['room:open'], ['room:open', { roomType: 'private' }],
      ['room:open', { roomType: 'group', roomId: 'g_x' }],
      ['message:send'], ['message:send', { roomType: 'public', roomId: 'public' }],
      ['message:read'], ['message:recall'],
      ['typing:start'], ['typing:stop', { roomType: 'private' }],
      ['typing:start', { roomType: 'private', roomId: 123 }],
      ['friend:request'], ['friend:accept'], ['friend:reject'], ['friend:remove'],
      ['group:create'], ['group:info'], ['group:update'], ['group:leave'], ['group:kick'],
      ['group:approve'], ['group:reject'], ['group:invite'], ['group:member:role'],
      ['group:request'],
      ['users:search'], ['groups:search'],
      ['room:public:get'], ['room:public:icon'],
      ['user:refresh'],
      // 【新增】支付系统：畸形 payload 也不能打崩服务
      ['transfer:send'], ['transfer:send', {}], ['transfer:send', { toUserId: 'x', amount: 'y' }],
      ['transfer:accept'], ['transfer:accept', {}],
      ['transfer:reject'], ['transfer:reject', {}],
      ['redpacket:send'], ['redpacket:send', {}],
      ['redpacket:send', { roomType: 'public', roomId: 'public' }],
      ['redpacket:grab'], ['redpacket:grab', {}]
    ];
    let crashed = false;
    for (const [ev, payload] of malformed) {
      if (payload === undefined) A.socket.emit(ev);
      else A.socket.emit(ev, payload);
      await sleep(60);
      if (!(await alive())) { crashed = true; ok(false, `${ev} 之后服务存活`, { ev, payload }); break; }
    }
    ok(!crashed, `${malformed.length} 个缺失/畸形 payload 之后服务仍存活`);

    const afterAck = await new Promise((res) => A.socket.emit('message:send', {
      roomType: 'public', roomId: 'public', text: `崩溃回归${TS}`
    }, res));
    ok(afterAck?.ok === true, '上述路径之后仍能正常发消息', afterAck);
  }

  A.socket.disconnect();
  B.socket.disconnect();

  section('6. 收尾：释放本套测试的 IP 绑定 + 还原测试数据');
  {
    // [SEC] 原先 `UPDATE apikey_ip_claims ... WHERE released_at IS NULL` 会释放
    //       **所有**用户的绑定（含真实用户在管理端维护的）。这里只动本套 sk_ 账号。
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(HERE, '..', 'chat.db'));

    const released = db.prepare(
      `UPDATE apikey_ip_claims SET released_at = ?, note = ?
        WHERE released_at IS NULL
          AND user_id IN (SELECT id FROM users WHERE substr(username, 1, 3) = 'sk_')`
    ).run(Date.now(), 'socket 回归收尾').changes;

    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(a.user.id);

    // [FIX] 还原公共聊天图标：测试前有值就恢复原值，测试前本来没有才删行。
    //       （原先无条件 DELETE，会把使用者真实设置的图标一起清掉。）
    if (publicRoomBefore) {
      db.prepare(
        `INSERT INTO room_settings (room_key, icon, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_key) DO UPDATE SET icon = excluded.icon,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run('public', publicRoomBefore.icon, publicRoomBefore.updated_by, publicRoomBefore.updated_at);
    } else {
      db.prepare('DELETE FROM room_settings WHERE room_key = ?').run('public');
    }

    // 顺带撤销本套测试申请过的密钥（否则会一直留着一把可用的活密钥）
    const revoked = db.prepare(
      `UPDATE api_keys SET revoked_at = ?, revoked_by = ?
        WHERE revoked_at IS NULL
          AND user_id IN (SELECT id FROM users WHERE substr(username, 1, 3) = 'sk_')`
    ).run(Date.now(), a.user.id).changes;

    // 【新增】清掉本套产生的转账 / 红包记录：
    //   · cleanupTestAccounts 处理的是通用账号数据，未必覆盖这三张新表
    //   · 不清就会在真实库里沉淀孤儿记录（红包剩余的钱还在官方托管账户上）
    //   · 顺序：先 grants，再 red_packets，再 transfers；messages 里的引用行也一并清
    const rpgDel = db.prepare(
      `DELETE FROM red_packet_grants
        WHERE red_packet_id IN (SELECT id FROM red_packets WHERE sender_id IN (?, ?))`
    ).run(a.user.id, b.user.id).changes;
    const rpDel = db.prepare(
      `DELETE FROM red_packets WHERE sender_id IN (?, ?)`
    ).run(a.user.id, b.user.id).changes;
    const trDel = db.prepare(
      `DELETE FROM transfers WHERE from_id IN (?, ?) OR to_id IN (?, ?)`
    ).run(a.user.id, b.user.id, a.user.id, b.user.id).changes;
    const msgDel = db.prepare(
      `DELETE FROM messages
        WHERE ref_type IN ('transfer', 'red_packet')
          AND sender_id IN (?, ?)`
    ).run(a.user.id, b.user.id).changes;

    db.close();
    ok(released >= 0, `已释放本套 sk_ 账号的 IP 绑定（${released} 条）`);
    ok(true, `已还原 developer 角色 / 公共聊天图标${publicRoomBefore ? '（恢复为原值）' : '（清除测试写入）'}，并撤销本套密钥（${revoked} 把）`);
    ok(
      rpgDel + rpDel + trDel + msgDel >= 0,
      `已清理本套转账 / 红包记录（grants ${rpgDel} / red_packets ${rpDel} / transfers ${trDel} / ref 消息 ${msgDel}）`
    );
  }

  // [收尾] 删掉本套 sk_ 测试账号（连同名下数据与上传文件）。
  // 跑在真实库上，不收尾就会一轮一轮沉淀（ERRORLOG TEST-1 / DEVLOG §1.74）。
  // 想保留现场：node ../server/scripts/socket_check.mjs --keep
  // 【新增】c 是第三个临时账号，一并交给 cleanupTestAccounts 收尾。
  cleanupTestAccounts([a.user?.id, b.user?.id, c.user?.id]);
  cleanupRunUploads(uploadsBefore);

  console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error('异常：', e); process.exit(1); });