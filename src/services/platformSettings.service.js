const SystemSetting = require("../models/systemSetting");

/** مفاتيح الإعدادات المعروفة وقيمها الافتراضية */
const DEFAULTS = {
  referral_reward_points: { points: 3 },
  referral_program_enabled: { enabled: true },

  store_competitions_enabled: { enabled: true },
  marketplace_enabled: { enabled: true },
  draws_enabled: { enabled: true },

  wheel_enabled: { enabled: true },
  wheel_spin_cost: { cost: 5 },
  wheel_spin_interval_ms: { ms: 3000 },
  wheel_placements: {
    header: true,
    userCenter: true,
    inventory: true,
  },

  store_owner_cart_enabled: { enabled: true },
  store_owner_competitions_enabled: { enabled: true },
  store_owner_member_prizes_enabled: { enabled: true },
  store_owner_warehouses_enabled: { enabled: true },

  maintenance_mode_enabled: {
    enabled: false,
    message: "الموقع تحت الصيانة حالياً. نعمل على تحسين تجربتكم ونعود قريباً.",
  },
};

const CACHE_TTL_MS = 30_000;
let cache = { at: 0, map: null };

async function loadMap() {
  const now = Date.now();
  if (cache.map && now - cache.at < CACHE_TTL_MS) return cache.map;

  const docs = await SystemSetting.find({
    key: { $in: Object.keys(DEFAULTS) },
  }).lean();

  const map = { ...DEFAULTS };
  for (const doc of docs) {
    map[doc.key] = { ...DEFAULTS[doc.key], ...doc.value };
  }

  cache = { at: now, map };
  return map;
}

function clearCache() {
  cache = { at: 0, map: null };
}

async function getValue(key) {
  const map = await loadMap();
  return map[key] ?? DEFAULTS[key] ?? null;
}

async function isEnabled(key) {
  const val = await getValue(key);
  if (!val || typeof val.enabled !== "boolean") return true;
  return val.enabled;
}

async function getReferralRewardPoints() {
  const val = await getValue("referral_reward_points");
  return val?.points ?? DEFAULTS.referral_reward_points.points;
}

async function getWheelSettings() {
  const map = await loadMap();
  return {
    enabled: map.wheel_enabled?.enabled !== false,
    spinCost: map.wheel_spin_cost?.cost ?? DEFAULTS.wheel_spin_cost.cost,
    spinIntervalMs: map.wheel_spin_interval_ms?.ms ?? DEFAULTS.wheel_spin_interval_ms.ms,
    placements: {
      ...DEFAULTS.wheel_placements,
      ...map.wheel_placements,
    },
  };
}

async function getStoreOwnerPageSettings() {
  const map = await loadMap();
  return {
    cart: map.store_owner_cart_enabled?.enabled !== false,
    competitions: map.store_owner_competitions_enabled?.enabled !== false,
    memberPrizes: map.store_owner_member_prizes_enabled?.enabled !== false,
    warehouses: map.store_owner_warehouses_enabled?.enabled !== false,
  };
}

async function getMaintenanceInfo() {
  const val = await getValue("maintenance_mode_enabled");
  return {
    enabled: val?.enabled === true,
    message:
      val?.message?.trim() ||
      DEFAULTS.maintenance_mode_enabled.message,
  };
}

async function isMaintenanceMode() {
  const info = await getMaintenanceInfo();
  return info.enabled;
}

/** إعدادات عامة للواجهات (زبون / عام) */
async function getPublicSettings() {
  const map = await loadMap();
  const wheel = await getWheelSettings();
  const { getVerificationPolicy } = require("../utils/verification.util");

  return {
    maintenanceMode: await getMaintenanceInfo(),
    features: {
      referralProgram: map.referral_program_enabled?.enabled !== false,
      storeCompetitions: map.store_competitions_enabled?.enabled !== false,
      marketplace: map.marketplace_enabled?.enabled !== false,
      draws: map.draws_enabled?.enabled !== false,
      wheel: wheel.enabled,
    },
    referralRewardPoints: map.referral_reward_points?.points ?? DEFAULTS.referral_reward_points.points,
    wheel: {
      enabled: wheel.enabled,
      spinCost: wheel.spinCost,
      placements: wheel.placements,
    },
    verification: getVerificationPolicy(),
  };
}

/** ملخص للوحة الأدمن */
async function getAdminSummary() {
  const map = await loadMap();
  const wheel = await getWheelSettings();

  return {
    maintenanceModeEnabled: (await getMaintenanceInfo()).enabled,
    maintenanceMessage: (await getMaintenanceInfo()).message,
    referralPoints: map.referral_reward_points?.points ?? DEFAULTS.referral_reward_points.points,
    referralProgramEnabled: map.referral_program_enabled?.enabled !== false,
    storeCompetitionsEnabled: map.store_competitions_enabled?.enabled !== false,
    marketplaceEnabled: map.marketplace_enabled?.enabled !== false,
    drawsEnabled: map.draws_enabled?.enabled !== false,
    wheelEnabled: wheel.enabled,
    wheelSpinCost: wheel.spinCost,
    wheelSpinIntervalMs: wheel.spinIntervalMs,
    wheelPlacements: wheel.placements,
    storeOwnerPages: await getStoreOwnerPageSettings(),
  };
}

module.exports = {
  DEFAULTS,
  clearCache,
  getValue,
  isEnabled,
  getReferralRewardPoints,
  getWheelSettings,
  getStoreOwnerPageSettings,
  getMaintenanceInfo,
  isMaintenanceMode,
  getPublicSettings,
  getAdminSummary,
};
