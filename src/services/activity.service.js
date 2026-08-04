const UserActivity = require("../models/userActivity");
const { safeLog } = require("../utils/logSanitize.util");

/**
 * خدمة تسجيل النشاط المركزية (AD-007/AD-009).
 * fire-and-forget: لا ترمي استثناءً يُسقط الطلب الأساسي.
 */
async function log({ user, type, targetType, targetId, meta } = {}) {
  if (!user || !type) return null;
  try {
    return await UserActivity.create({
      user,
      type,
      targetType: targetType || null,
      targetId: targetId || null,
      meta: meta || {},
    });
  } catch (err) {
    safeLog("error", "user_activity_log_failed", { message: err.message, userId: user, type });
    return null;
  }
}

module.exports = { log };
