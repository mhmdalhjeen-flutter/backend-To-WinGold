const Store = require("../models/store");
const paymentMethodService = require("../services/storePaymentMethod.service");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

async function getOwnerStore(userId) {
  const store = await Store.findOne({ owner: userId });
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }
  return store;
}

exports.listMyPaymentMethods = async (req, res) => {
  try {
    const store = await getOwnerStore(req.user.id);
    const payload = await paymentMethodService.getOwnerPaymentSettings(store);
    res.json(payload);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.updateMyPaymentMethodToggles = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentMethods");
    const store = await getOwnerStore(req.user.id);
    const payload = await paymentMethodService.updateStorePaymentToggles(
      store,
      req.body.paymentMethods || req.body,
    );
    res.json({ message: "تم تحديث طرق الدفع", ...payload });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.createMyPaymentMethod = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentMethod");
    const store = await getOwnerStore(req.user.id);
    const method = await paymentMethodService.createForStore(store._id, req.body);
    res.status(201).json({ message: "تم إضافة حساب الدفع", method });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.updateMyPaymentMethod = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentMethod");
    const store = await getOwnerStore(req.user.id);
    const method = await paymentMethodService.updateForStore(store._id, req.params.id, req.body);
    res.json({ message: "تم تحديث حساب الدفع", method });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.activateMyPaymentMethod = async (req, res) => {
  try {
    const store = await getOwnerStore(req.user.id);
    const method = await paymentMethodService.activateForStore(store._id, req.params.id);
    res.json({ message: "تم تفعيل حساب الدفع", method });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.deleteMyPaymentMethod = async (req, res) => {
  try {
    const store = await getOwnerStore(req.user.id);
    await paymentMethodService.deleteForStore(store._id, req.params.id);
    res.json({ message: "تم حذف حساب الدفع" });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.getPaymentMethodTypes = async (_req, res) => {
  try {
    res.json({ types: paymentMethodService.getPaymentMethodTypes() });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

/** Public checkout — enabled methods + active accounts only (via paymentSettings). */
exports.getActiveStorePaymentMethods = async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const store = await Store.findById(storeId).select("_id name isActive paymentMethods").lean();
    if (!store) {
      return res.status(404).json({ message: "المتجر غير موجود" });
    }

    const { paymentSettings, enabledPaymentMethods } = await paymentMethodService.buildPaymentSettingsForStore(store);
    const methods = await paymentMethodService.getActiveForStore(store._id);
    res.json({
      storeId: store._id,
      paymentSettings,
      enabledPaymentMethods,
      methods,
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};
