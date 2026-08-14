const { safeLog } = require("./logSanitize.util");

/**
 * Billing cycle closure is admin-triggered via POST /admin/delivery-subscriptions/request.
 * This monitor intentionally does not auto-close counting periods.
 */
const monitorDeliveryBilling = async () => {
  safeLog("debug", "delivery_billing_monitor_tick", { autoClose: false });
};

module.exports = { monitorDeliveryBilling };
