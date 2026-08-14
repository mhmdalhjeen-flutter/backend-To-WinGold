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

    if (status.needsPayment) {
      const rejected = Boolean(status.paymentRejected);
      return res.status(403).json({
        message: rejected
          ? "تم رفض دفع الاشتراك — يرجى تصحيح بيانات الدفع"
          : "مطلوب دفع الاشتراك الشهري قبل متابعة استخدام البوابة",
        billingStatus: status.billingStatus,
        code: rejected ? "billing_payment_rejected" : "billing_payment_required",
        needsPayment: true,
        canOperate: false,
      });
    }

    return next();
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
}

module.exports = {
  requireDeliveryBillingAccess,
};
