const deliveryCompanyBillingService = require("../services/deliveryCompanyBilling.service");
const { safeLog } = require("./logSanitize.util");

const monitorDeliveryBilling = async () => {
  try {
    const finalized = await deliveryCompanyBillingService.closeCountingPeriodsForPastMonths();
    if (finalized.length) {
      safeLog("info", "delivery_billing_periods_finalized", { count: finalized.length });
    }
  } catch (err) {
    safeLog("error", "delivery_billing_monitor_failed", { message: err.message });
  }
};

module.exports = { monitorDeliveryBilling };
