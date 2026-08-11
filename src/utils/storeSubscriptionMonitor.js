const storeSubscriptionService = require("../services/storeSubscription.service");
const { safeLog } = require("./logSanitize.util");

/**
 * Expire subscription cards from previous months and remove unused subscription paper codes.
 */
const monitorStoreSubscriptions = async () => {
  try {
    const expired = await storeSubscriptionService.expireEndedSubscriptionPeriods();
    if (expired.length) {
      safeLog("info", "store_subscription_periods_expired", { count: expired.length });
    }
  } catch (err) {
    safeLog("error", "store_subscription_monitor_failed", { message: err.message });
  }
};

module.exports = { monitorStoreSubscriptions };
