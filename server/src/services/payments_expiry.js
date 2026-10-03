// src/services/payments_expiry.js
//
// 转账 / 红包的过期扫描。每 60 秒跑一次：
//   · pending 转账 → 退回发送者
//   · active 红包 → 剩余部分退回发送者
//
// 用 unref() 定时器，不阻塞进程退出。
// 单次扫最多 100 条（LIMIT 100），分批消化；下一轮继续。
//
const transfers = require('./transfers');
const redpackets = require('./redpackets');
const registry = require('../socket/registry');

const INTERVAL_MS = 60 * 1000;

function runOnce() {
  try {
    const expiredT = transfers.sweepExpired();
    for (const t of expiredT) {
      // 双方都要通知（发送者收到退款、接收者看到"已过期"）
      registry.sendTo(t.fromId, 'transfer:expired', { transfer: t });
      registry.sendTo(t.toId,   'transfer:expired', { transfer: t });
    }
    if (expiredT.length > 0) {
      console.log(`[payments] 过期退回 ${expiredT.length} 笔转账`);
    }
  } catch (err) {
    console.error('[payments] 转账过期扫描失败：', err);
  }

  try {
    const expiredR = redpackets.sweepExpired();
    for (const r of expiredR) {
      registry.emitToRoom(r.roomType, r.roomId, 'redpacket:expired', { redPacket: r });
    }
    if (expiredR.length > 0) {
      console.log(`[payments] 过期退回 ${expiredR.length} 个红包`);
    }
  } catch (err) {
    console.error('[payments] 红包过期扫描失败：', err);
  }
}

function start() {
  const timer = setInterval(runOnce, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // 启动 5 秒后先扫一遍（把上次重启期间漏掉的处理掉）
  setTimeout(runOnce, 5000).unref?.();
  return timer;
}

module.exports = { start, runOnce, INTERVAL_MS };
