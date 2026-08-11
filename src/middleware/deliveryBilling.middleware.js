const deliveryCompanyBillingService = require("../services/deliveryCompanyBilling.service");

function isBillingRoute(req) {
  const path = String(req.originalUrl || req.path || "");
  return path.includes("/company/billing");
}

async function requireDeliveryBillingAccess(req, res, next) {
  try {
    const companyId = req.userDoc?.deliveryCompanyId || req.user?.deliveryCompanyId;
    if (!companyId) {
      return res.status(404).json({ message: "لا توجد شركة توصيل مرتبطة بحسابك" });
    }

    const status = await deliveryCompanyBillingService.getCompanyBillingStatus(companyId);
    req.deliveryBilling = status;

    if (isBillingRoute(req.path)) {
      return next();
    }

    if (status.paymentRejected) {
      return res.status(403).json({
        message: "تم رفض دفع الاشتراك — يرجى تصحيح بيانات الدفع",
        billingStatus: status.billingStatus,
        code: "billing_payment_rejected",
      });
    }

    return next();
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
}

module.exports = {
  requireDeliveryBillingAccess,
  BILLING_STATUSES,
};
