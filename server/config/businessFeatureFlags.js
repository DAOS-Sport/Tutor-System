/**
 * 主管功能的集中式 feature flags。
 *
 * 全域旗標預設關閉；共享權益三項先只對指定事故家庭做 canary，避免 PUBLISH 後
 * 全量改變其他課程。canary 名單可用同名 *_CANARY_PARENT_PHONES 覆寫。
 */
const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on']);
const TARGET_SHARED_CANARY_PHONES = ['0982252694'];

const FLAGS = Object.freeze({
  SHARED_ENTITLEMENT_FIX: { defaultCanaryPhones: TARGET_SHARED_CANARY_PHONES },
  SHARED_CHECKIN_USAGE_V2: { defaultCanaryPhones: TARGET_SHARED_CANARY_PHONES },
  DEDUCTION_REVIVAL_V2: { defaultCanaryPhones: TARGET_SHARED_CANARY_PHONES },
  GROUP_VENUE_DISPLAY_V2: {},
  LINE_NOTIFICATION_BINDING_V2: {},
  TRIAL_ONSITE_CHECKOUT_V2: {},
  RECONCILE_VENUE_ARCHIVE_V2: {},
  UNASSIGNED_COACH_V2: {},
});

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isGloballyEnabled(name, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(FLAGS, name)) return false;
  return BOOLEAN_TRUE.has(String(env[name] || 'false').trim().toLowerCase());
}

function canaryPhones(name, env = process.env) {
  const definition = FLAGS[name];
  if (!definition) return [];
  const envName = `${name}_CANARY_PARENT_PHONES`;
  const configured = Object.prototype.hasOwnProperty.call(env, envName)
    ? parseList(env[envName])
    : (definition.defaultCanaryPhones || []);
  return configured.map(normalizePhone).filter(Boolean);
}

function isEnabledFor(name, context = {}, env = process.env) {
  if (isGloballyEnabled(name, env)) return true;
  const phone = normalizePhone(context.parentPhone);
  return !!phone && canaryPhones(name, env).includes(phone);
}

module.exports = {
  FLAGS,
  normalizePhone,
  isGloballyEnabled,
  isEnabledFor,
  canaryPhones,
};
