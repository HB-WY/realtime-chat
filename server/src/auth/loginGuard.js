// src/auth/loginGuard.js
//
// 登录失败限流（按 IP + 按账号，滑动窗口）。
//
// [SEC] 登录接口原本**没有任何频率限制**：连续 12 次错误密码全部返回 401，
//       既没有 429、也没有验证码或锁定 —— 对已知用户名可以在线爆破。
//       配合 /api/v1/state 之类的用户枚举通道，成本极低。
//
// 设计要点：
//   · 只统计**失败**，成功即清掉该账号的计数 —— 正常用户手误几次不会被挡；
//   · 两个维度都要过：IP 维度挡「一个来源轮着试很多账号」，账号维度挡
//     「很多来源盯一个账号试」（后者可能来自僵尸网络，IP 维度挡不住）；
//   · 计数器是进程内 Map，沿用 auth/apikey.js 的 prune 策略（定期 + 每 N 次操作）
//     防止长期运行内存只增不减；重启即清空，也会自然解除锁定；
//   · 响应**不区分**是哪个维度触发的，避免变成「这个账号存在吗」的信息通道。
//
const config = require('../config');
const { clientIp } = require('../utils/ip');

const RL = config.RATE_LIMITS.login || {};
const WINDOW_MS = Number(RL.window_ms) > 0 ? Number(RL.window_ms) : 15 * 60 * 1000;
const MAX_PER_IP = Number(RL.max_per_ip) > 0 ? Number(RL.max_per_ip) : 30;
const MAX_PER_ACCOUNT = Number(RL.max_per_account) > 0 ? Number(RL.max_per_account) : 10;

/** key -> 命中时间戳数组 */
const buckets = new Map();

let opCount = 0;
const PRUNE_EVERY = 500;

function prune() {
  const now = Date.now();
  for (const [key, arr] of buckets) {
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) buckets.delete(key);
    else if (kept.length !== arr.length) buckets.set(key, kept);
  }
}

const pruneTimer = setInterval(prune, 5 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

function tick() {
  if (++opCount >= PRUNE_EVERY) {
    opCount = 0;
    prune();
  }
}

function bucketKey(kind, value) {
  return `${kind}:${value}`;
}

/** 取窗口内仍有效的记录（顺带把过期项清掉） */
function live(key) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length === 0) buckets.delete(key);
  else buckets.set(key, arr);
  return arr;
}

/** 还要等多少秒才能再试（按最紧的那个维度算） */
function retryAfterOf(arr) {
  if (arr.length === 0) return 0;
  const oldest = Math.min(...arr);
  return Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - oldest)) / 1000));
}

function accountKey(username) {
  // 统一小写 + 截断：避免用大小写 / 超长用户名把计数打散
  return String(username || '').trim().toLowerCase().slice(0, 64);
}

/**
 * 是否允许这次登录尝试。
 * @returns {{ok:true}|{ok:false,retryAfter:number}}
 */
function check(req, username) {
  const ipArr = live(bucketKey('ip', clientIp(req)));
  const accArr = live(bucketKey('acct', accountKey(username)));

  const ipBlocked = ipArr.length >= MAX_PER_IP;
  const accBlocked = accArr.length >= MAX_PER_ACCOUNT;
  if (!ipBlocked && !accBlocked) return { ok: true };

  const waits = [];
  if (ipBlocked) waits.push(retryAfterOf(ipArr));
  if (accBlocked) waits.push(retryAfterOf(accArr));
  return { ok: false, retryAfter: Math.max(...waits) };
}

/** 记一次失败（IP + 账号都记） */
function fail(req, username) {
  const now = Date.now();
  for (const key of [bucketKey('ip', clientIp(req)), bucketKey('acct', accountKey(username))]) {
    const arr = (buckets.get(key) || []).filter((t) => now - t < WINDOW_MS);
    arr.push(now);
    buckets.set(key, arr);
  }
  tick();
}

/**
 * 登录成功：清掉该账号的失败计数。
 * 注意**不清** IP 计数 —— 否则攻击者只要手里有一个可用账号，
 * 就能用一次成功登录把来源 IP 的累计失败清零，从而绕过 IP 维度。
 */
function reset(req, username) {
  buckets.delete(bucketKey('acct', accountKey(username)));
  tick();
}

module.exports = { check, fail, reset, pruneState: prune };
