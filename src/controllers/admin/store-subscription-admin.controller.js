const Store = require("../../models/store");
const storeSubscriptionService = require("../../services/storeSubscription.service");
const platformSubscriptionPaymentService = require("../../services/platformSubscriptionPayment.service");
const { getPaymentTypeLabel } = require("../../utils/paymentMethodTypes.util");
const { requireObjectId, assertNoMongoOperators } = require("../../utils/inputSecurity.util");
const { getCurrentMonthKey } = require("../../utils/subscriptionMonth.util");
const { buildGiftCodesExcelBuffer, buildGiftCodesExportFilename } = require("../../utils/giftCodeExcelExport.util");
const { sendExcelDownload } = require("../../utils/excelDownload.util");

exports.listSubscriptionCards = async (req, res) => {
  try {
    const monthKey = req.query.monthKey || getCurrentMonthKey();
    const cards = await storeSubscriptionService.listAdminSubscriptionCards(monthKey);
    res.json({ monthKey, cards });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.approveSubscriptionPayment = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const period = await storeSubscriptionService.approveSubscriptionPayment(periodId, req.user.id);
    res.json({ message: "تم اعتماد الدفع وتفعيل الاشتراك", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.rejectSubscriptionPayment = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const reason = String(req.body?.reason || req.body?.rejectionReason || "").trim();
    const period = await storeSubscriptionService.rejectSubscriptionPayment(periodId, req.user.id, reason);
    res.json({ message: "تم رفض الدفع", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exemptStoreSubscription = async (req, res) => {
  try {
    const storeId = requireObjectId(req.params.storeId, "storeId");
    const monthKey = req.body?.monthKey || getCurrentMonthKey();
    const period = await storeSubscriptionService.exemptStoreForMonth(storeId, req.user.id, monthKey);
    res.json({ message: "تم إعفاء المتجر لهذا الشهر", period });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exemptAllExcept = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "exemptAllExcept");
    const keepStoreIds = Array.isArray(req.body?.keepStoreIds) ? req.body.keepStoreIds : [];
    const monthKey = req.body?.monthKey || getCurrentMonthKey();
    const result = await storeSubscriptionService.exemptAllExcept(keepStoreIds, req.user.id, monthKey);
    res.json({
      message: `تم إعفاء ${result.exemptedCount} متجر لهذا الشهر`,
      ...result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.setStoreCardQuantities = async (req, res) => {
  try {
    const storeId = requireObjectId(req.params.storeId, "storeId");
    assertNoMongoOperators(req.body, "cardQuantities");
    const cardConfig = await storeSubscriptionService.setStoreCardQuantities(storeId, req.body);
    res.json({ message: "تم حفظ كميات الكروت", cardConfig });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exportSubscriptionPaperCodes = async (req, res) => {
  try {
    const periodId = requireObjectId(req.params.periodId, "periodId");
    const exportData = await storeSubscriptionService.getSubscriptionPaperCodesForExport(periodId);
    const xlsxBuffer = await buildGiftCodesExcelBuffer({
      codes: exportData.codes,
      storeName: exportData.storeName,
    });

    sendExcelDownload(res, xlsxBuffer, buildGiftCodesExportFilename(exportData.storeName));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getStoreOwnerContact = async (req, res) => {
  try {
    const storeId = requireObjectId(req.params.storeId, "storeId");
    const store = await Store.findById(storeId)
      .select("name phone whatsapp owner")
      .populate("owner", "name email phone")
      .lean();
    if (!store) return res.status(404).json({ message: "المتجر غير موجود" });
    res.json({
      store: {
        _id: store._id,
        name: store.name,
        phone: store.phone,
        whatsapp: store.whatsapp,
      },
      owner: store.owner || null,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPlatformPaymentAccounts = async (req, res) => {
  try {
    const accounts = await platformSubscriptionPaymentService.listAllAccounts();
    res.json({
      accounts: accounts.map((account) => ({
        ...account,
        label: getPaymentTypeLabel(account.type),
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createPlatformPaymentAccount = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "platformPaymentAccount");
    const account = await platformSubscriptionPaymentService.createAccount(req.body);
    res.status(201).json({ message: "تم إضافة حساب الدفع", account });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updatePlatformPaymentAccount = async (req, res) => {
  try {
    const accountId = requireObjectId(req.params.accountId, "accountId");
    assertNoMongoOperators(req.body, "platformPaymentAccount");
    const account = await platformSubscriptionPaymentService.updateAccount(accountId, req.body);
    res.json({ message: "تم تحديث حساب الدفع", account });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.activatePlatformPaymentAccount = async (req, res) => {
  try {
    const accountId = requireObjectId(req.params.accountId, "accountId");
    const account = await platformSubscriptionPaymentService.activateAccount(accountId);
    res.json({ message: "تم تفعيل حساب الدفع", account });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.deletePlatformPaymentAccount = async (req, res) => {
  try {
    const accountId = requireObjectId(req.params.accountId, "accountId");
    await platformSubscriptionPaymentService.deleteAccount(accountId);
    res.json({ message: "تم حذف حساب الدفع" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
