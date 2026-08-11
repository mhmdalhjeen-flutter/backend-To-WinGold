const Store = require("../models/store");
const storeSubscriptionService = require("../services/storeSubscription.service");
const platformSubscriptionPaymentService = require("../services/platformSubscriptionPayment.service");
const { serializePaymentForOwner } = require("../utils/storeSubscriptionPayment.util");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

async function resolveOwnerStore(req) {
  const store = await Store.findOne({ owner: req.user.id, isActive: true });
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }
  return store;
}

exports.getMySubscriptionStatus = async (req, res) => {
  try {
    const store = await resolveOwnerStore(req);
    const status = await storeSubscriptionService.getStoreSubscriptionStatus(store._id);
    res.json({
      ...status,
      payment: serializePaymentForOwner(status.period),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getSubscriptionPaymentMethods = async (req, res) => {
  try {
    const methods = await platformSubscriptionPaymentService.listActiveAccountsForStores();
    res.json({ methods });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.submitSubscriptionPayment = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "subscriptionPayment");
    const store = await resolveOwnerStore(req);
    const status = await storeSubscriptionService.submitSubscriptionPayment(store._id, req.body);
    res.json({
      message: "تم إرسال بيانات الدفع — قيد المراجعة",
      ...status,
      payment: serializePaymentForOwner(status.period),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exportMySubscriptionPaperCodes = async (req, res) => {
  try {
    const store = await resolveOwnerStore(req);
    const status = await storeSubscriptionService.getStoreSubscriptionStatus(store._id);
    if (!status.period?._id) {
      return res.status(400).json({ message: "لا توجد فترة اشتراك للتصدير" });
    }

    const { buildGiftCodesExcelBuffer, buildGiftCodesExportFilename } = require("../utils/giftCodeExcelExport.util");
    const exportData = await storeSubscriptionService.getSubscriptionPaperCodesForExport(status.period._id);
    const xlsxBuffer = await buildGiftCodesExcelBuffer({
      codes: exportData.codes,
      storeName: exportData.storeName,
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildGiftCodesExportFilename(exportData.storeName)}"`,
    );
    res.send(xlsxBuffer);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
