// src/services/plagiarism.js
const crypto = require('crypto');
const { db } = require('../db');
const PLAG_CFG = require('../config').BUSINESS.shop.plagiarism;

const SIMILARITY_THRESHOLD = PLAG_CFG.similarity_threshold;
const CANDIDATE_LIMIT      = PLAG_CFG.candidate_limit;

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function shingles(str, n = 3) {
  const s = normalizeText(str);
  if (s.length < n) return s ? [s] : [];
  const out = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function simhash(text) {
  const tokens = shingles(text);
  if (tokens.length === 0) return 0n;
  const v = new Array(64).fill(0);
  for (const t of tokens) {
    const h1 = BigInt(fnv1a32(t));
    const h2 = BigInt(fnv1a32(t + '#salt'));
    const h = (h2 << 32n) | h1;
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] += bit === 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) out |= (1n << BigInt(i));
  }
  return out;
}

function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0n;
  while (x) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return Number(count);
}

function similarityPercent(dist) {
  if (dist <= 0) return 100;
  if (dist >= 32) return 0;
  return Math.round(100 * (1 - dist / 32));
}

function detectPlagiarism(newProduct) {
  const results = [];

  // [FIX] 精确哈希 / 文件哈希命中必须排除卖家自己：
  //   卖家下架后重发同素材、或商品售出后重新上架，都会被判成
  //   「抄袭自己的旧商品」直接置 pirated —— 合法操作被误杀。
  //   同时限定同类目（goods 不会和表情包互拦）。
  const cat = newProduct.category || 'goods';
  const inScope = `status IN ('on_sale','sold','pending_review') AND category = ? AND seller_id != ?`;

  const exact = db.prepare(
    `SELECT id FROM products
     WHERE content_hash = ? AND ${inScope}
     ORDER BY created_at ASC LIMIT 1`
  ).get(newProduct.contentHash, cat, newProduct.sellerId);
  if (exact) {
    results.push({ productId: exact.id, similarity: 100, reason: '文件内容完全一致' });
    return results;
  }

  // 素材文件级 sha256 比对：同一份文件换个标题重发同样会被拦下
  if (newProduct.fileHash) {
    const dupFile = db.prepare(
      `SELECT id FROM products
       WHERE file_hash = ? AND file_hash IS NOT NULL
         AND ${inScope}
       ORDER BY created_at ASC LIMIT 1`
    ).get(newProduct.fileHash, cat, newProduct.sellerId);
    if (dupFile) {
      results.push({ productId: dupFile.id, similarity: 100, reason: '素材文件 sha256 完全一致' });
      return results;
    }
  }

  // [NOTE] simhash 候选集按 created_at 倒序截断到 candidate_limit：
  //   更早的商品不在比对范围内（性能取舍）。类目与卖家过滤已下推到 SQL。
  const candidates = db.prepare(
    `SELECT id, simhash FROM products
     WHERE status IN ('on_sale','sold','pending_review')
       AND category = ?
       AND seller_id != ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(cat, newProduct.sellerId, CANDIDATE_LIMIT);

  for (const c of candidates) {
    let cHash;
    try { cHash = BigInt(c.simhash); } catch { continue; }
    const dist = hammingDistance(newProduct.simhash, cHash);
    const sim = similarityPercent(dist);
    if (sim >= SIMILARITY_THRESHOLD) {
      results.push({ productId: c.id, similarity: sim, reason: `文本相似度 ${sim}%` });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

module.exports = {
  normalizeText, sha256, simhash, hammingDistance, similarityPercent,
  detectPlagiarism, SIMILARITY_THRESHOLD
};