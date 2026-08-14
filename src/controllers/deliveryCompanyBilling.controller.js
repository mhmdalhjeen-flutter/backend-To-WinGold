const deliveryCompanyBillingService = require("../services/deliveryCompanyBilling.service");
const platformSubscriptionPaymentService = require("../services/platformSubscriptionPayment.service");
const { serializePaymentForOwner } = require("../utils/storeSubscriptionPayment.util");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

function resolveCompanyId(req) {
  const companyId = req.userDoc?.deliveryCompanyId || req.user?.deliveryCompanyId;
  if (!companyId) {
    const err = new Error("لا توجد شركة توصيل مرتبطة بحسابك");
    err.status = 404;
    throw err;
  }
  return companyId;
}

exports.getMyBillingStatus = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const status = await deliveryCompanyBillingService.getCompanyBillingStatus(companyId);
    const paymentPeriod = status.openPeriod || status.previousPeriod;
    res.json({
      ...status,
      payment: serializePaymentForOwner(paymentPeriod),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getBillingPaymentMethods = async (_req, res) => {
  try {
    const methods = await platformSubscriptionPaymentService.listActiveAccountsForStores();
    res.json({ methods });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.submitBillingPayment = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "billingPayment");
    const companyId = resolveCompanyId(req);
    const period = await deliveryCompanyBillingService.submitBillingPayment(
      companyId,
      req.body,
      req.body?.periodId || null,
    );
    const status = await deliveryCompanyBillingService.getCompanyBillingStatus(companyId);
    res.json({
      message: "تم إرسال بيانات الدفع — قيد المراجعة",
      ...status,
      payment: serializePaymentForOwner(period),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getBillingHistory = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const history = await deliveryCompanyBillingService.listBillingHistory(companyId);
    res.json({ history });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.startBillingSimulation = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const simulationService = require("../services/deliveryCompanyBillingSimulation.service");
    await simulationService.startBillingSimulation(companyId, req.user?.id);
    const status = await deliveryCompanyBillingService.getCompanyBillingStatus(companyId);
    const paymentPeriod = status.openPeriod || status.previousPeriod;
    res.json({
      message: "تم بدء محاكاة بداية شهر جديد",
      ...status,
      payment: serializePaymentForOwner(paymentPeriod),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.resetBillingSimulation = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const simulationService = require("../services/deliveryCompanyBillingSimulation.service");
    await simulationService.resetBillingSimulation(companyId);
    const status = await deliveryCompanyBillingService.getCompanyBillingStatus(companyId);
    const paymentPeriod = status.openPeriod || status.previousPeriod;
    res.json({
      message: "تم حذف المحاكاة واستعادة الحالة الحقيقية",
      ...status,
      payment: serializePaymentForOwner(paymentPeriod),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
