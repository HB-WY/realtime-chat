#!/usr/bin/env node
// scripts/cleanup_orphan_messages.mjs
//
// 清理「孤儿消息」：messages.sender_id 在 users 表里已经不存在。
//
// 为什么会有这种东西：
//   · messages 表没有 FOREIGN KEY ... ON DELETE CASCADE
//   · 清理工具删账号时（cleanup_test_accounts / socket_check 收尾），
//     users 里对应行没了，但 public 房间里的消息行还在
//   · loadHistory 一读就渲染出「XXX 说：xxx」，但那个用户其实已经不存在
//
// 用途：
//   · 跑完 socket_check / smoke_test 后，把测试账号发的 public 消息一起清掉
//   · 任何「删了账号但忘删消息」的历史残留
//
// 安全约束：
//   · 默认只演练，不删任何东西
//   · `--apply` 才真的 DELETE
//   · 只删「sender_id 不在 users 表里」的消息；只要用户还在，消息就保留
//   · 只处理 room_type IN ('public','private','group') —— 私聊/群聊的孤儿消息
//     也顺手清（它们同样看不到发送者，是残渣）
//   · 顺带清 message_reads 里指向这些消息的行
//
// 用法：
//   node scripts/cleanup_orphan_messages.mjs          # 演练：列出会被删的
//   node scripts/cleanup_orphan_messages.mjs --apply   # 真删
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'chat.db');
const APPLY = process.argv.includes('--apply');

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function preview(text, n = 40) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : (s || '（空）');
}

function main() {
  const db = new DatabaseSync(DB_PATH);

  // 1) 找出所有 sender_id 不在 users 里的消息
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id,
           m.sender_id, m.sender_name,
           m.text, m.file_name, m.file_type,
           m.ref_type, m.created_at
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
     WHERE u.id IS NULL
     ORDER BY m.created_at ASC
  `).all();

  console.log(`数据库：${DB_PATH}`);
  console.log(`模式：${APPLY ? 'APPLY（会真删）' : 'DRY-RUN（只演练）'}`);
  console.log('');

  if (rows.length === 0) {
    console.log('✓ 没有孤儿消息。数据库干净。');
    db.close();
    return;
  }

  // 2) 打印清单
  console.log(`找到 ${rows.length} 条孤儿消息（sender_id 已不在 users 表里）：\n`);

  // 按房间分组，看起来清楚
  const byRoom = new Map();
  for (const r of rows) {
    const key = `${r.room_type}:${r.room_id}`;
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(r);
  }
  for (const [roomKey, list] of byRoom) {
    console.log(`  [房间 ${roomKey}]  共 ${list.length} 条`);
    for (const r of list) {
      const kind = r.ref_type ? `<${r.ref_type}>` : '';
      const file = r.file_name ? `  [file=${r.file_name}]` : '';
      console.log(
        `    · id=${r.id}  sender=${r.sender_name}(#${r.sender_id})`
        + `  ${fmtTime(r.created_at)}  ${kind}${file}`
        + `  «${preview(r.text)}»`
      );
    }
    console.log('');
  }

  // 3) 统计 message_reads
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const readsCount = db.prepare(
    `SELECT COUNT(*) AS c FROM message_reads WHERE message_id IN (${ph})`
  ).get(...ids).c;
  console.log(`关联 message_reads 行数：${readsCount}\n`);

  if (!APPLY) {
    console.log('（演练结束，未删除任何内容。要真删请加 --apply）');
    db.close();
    return;
  }

  // 4) 真删
  db.exec('BEGIN IMMEDIATE');
  try {
    const delReads = db.prepare(
      `DELETE FROM message_reads WHERE message_id IN (${ph})`
    ).run(...ids).changes;
    const delMsgs = db.prepare(
      `DELETE FROM messages WHERE id IN (${ph})`
    ).run(...ids).changes;
    db.exec('COMMIT');
    console.log(`✓ 已删除 message_reads ${delReads} 行、messages ${delMsgs} 行。`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('删除失败，已回滚：', err);
    db.close();
    process.exit(1);
  }

  db.close();
  console.log('\n完成。');
}

main();