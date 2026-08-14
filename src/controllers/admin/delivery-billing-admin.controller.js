const deliveryCompanyBillingService = require("../../services/deliveryCompanyBilling.service");
const platformSubscriptionPaymentService = require("../../services/platformSubscriptionPayment.service");
const { serializePaymentForOwner } = require("../../utils/storeSubscriptionPayment.util");
const { assertNoMongoOperators, requireObjectId } = require("../../utils/inputSecurity.util");

exports.listBillingCards = async (req, res) => {
  try {
    const payload = await deliveryCompanyBillingService.listAdminBillingCards();
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.approveBillingPayment = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const period = await deliveryCompanyBillingService.approveBillingPayment(periodId, req.user.id);
    res.json({ message: "تم التحقق من الدفع وبدء دورة الفوترة الجديدة", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.rejectBillingPayment = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const reason = req.body?.reason || "";
    const period = await deliveryCompanyBillingService.rejectBillingPayment(periodId, req.user.id, reason);
    res.json({ message: "تم رفض الدفع", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exemptBillingPeriod = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const period = await deliveryCompanyBillingService.exemptBillingPeriod(periodId, req.user.id);
    res.json({ message: "تم إعفاء الشركة وبدء دورة الفوترة الجديدة", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.setPricePerOrder = async (req, res) => {
  try {
    const companyId = requireObjectId(req.params.companyId, "companyId");
    const updated = await deliveryCompanyBillingService.setPricePerDeliveredOrder(
      companyId,
      req.body?.pricePerDeliveredOrder,
    );
    res.json({
      message: "تم تحديث سعر الطلب",
      pricePerDeliveredOrder: updated,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getCompanyBillingHistory = async (req, res) => {
  try {
    const companyId = requireObjectId(req.params.companyId, "companyId");
    const history = await deliveryCompanyBillingService.listBillingHistory(companyId);
    res.json({ history });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getCompanyHandovers = async (req, res) => {
  try {
    const companyId = requireObjectId(req.params.companyId, "companyId");
    const handoverService = require("../../services/deliveryCompanyHandover.service");
    const { getCurrentMonthKey } = require("../../utils/subscriptionMonth.util");
    const unconfirmedOnly = req.query.unconfirmedOnly === "1"
      || req.query.unconfirmedOnly === "true";
    const monthKey = unconfirmedOnly
      ? (req.query.monthKey || null)
      : (req.query.monthKey || getCurrentMonthKey());

    const handovers = unconfirmedOnly
      ? await handoverService.listPendingCustomerDeliveriesForCompany(companyId, { monthKey })
      : await handoverService.listAdminHandoversForMonth(companyId, monthKey || getCurrentMonthKey());

    res.json({ monthKey, handovers, unconfirmedOnly });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPlatformPaymentMethods = async (_req, res) => {
  try {
    const methods = await platformSubscriptionPaymentService.listActiveAccountsForStores();
    res.json({ methods });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
