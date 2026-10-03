// src/services/permissions.js
const { db } = require('../db');
const cfg = require('../config').ROLES_CFG;

// ============================================================
// 角色（从 YAML 读）
// ============================================================
const ROLES                 = cfg.definitions;
const REQUESTABLE_ROLES     = cfg.requestable;
const PROMOTION_COOLDOWN_MS = cfg.promotion_cooldown_ms;
const CAPABILITIES          = cfg.capabilities;
const GRANTABLE_BY          = cfg.grantable_by;

function levelOf(role) {
  return ROLES[role]?.level ?? -1;
}

function getRole(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return row?.role || 'user';
}

function can(role, capability) {
  if (role === 'developer') return true;
  const need = CAPABILITIES[capability];
  if (need === undefined) return false;
  return levelOf(role) >= need;
}

function canOperate(actorRole, targetRole) {
  if (actorRole === 'developer') return true;
  return levelOf(actorRole) > levelOf(targetRole);
}

function canGrant(actorRole, newRole) {
  if (!ROLES[newRole]) return false;
  const grantable = GRANTABLE_BY[actorRole] || [];
  if (!grantable.includes(newRole)) return false;
  return actorRole === 'developer' || levelOf(newRole) < levelOf(actorRole);
}

function isInPromotionCooldown(userId) {
  const row = db.prepare('SELECT last_promoted_at FROM users WHERE id = ?').get(userId);
  if (!row || !row.last_promoted_at) return false;
  return Date.now() - row.last_promoted_at < PROMOTION_COOLDOWN_MS;
}

function cooldownRemainingMs(userId) {
  const row = db.prepare('SELECT last_promoted_at FROM users WHERE id = ?').get(userId);
  if (!row || !row.last_promoted_at) return 0;
  const remaining = PROMOTION_COOLDOWN_MS - (Date.now() - row.last_promoted_at);
  return remaining > 0 ? remaining : 0;
}

function isAdmin(role)      { return role === 'developer' || levelOf(role) >= 50; }
function isSuperAdmin(role) { return role === 'developer' || levelOf(role) >= 90; }
function isDeveloper(role)  { return role === 'developer'; }

function audit(actorId, actorRole, action, targetType, targetId, detail) {
  db.prepare(
    `INSERT INTO admin_audit (actor_id, actor_role, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(actorId, actorRole, action, targetType, targetId, detail || null, Date.now());
}

module.exports = {
  ROLES, CAPABILITIES, GRANTABLE_BY, REQUESTABLE_ROLES, PROMOTION_COOLDOWN_MS,
  levelOf, getRole, can, canOperate, canGrant,
  isInPromotionCooldown, cooldownRemainingMs,
  isAdmin, isSuperAdmin, isDeveloper,
  audit
};