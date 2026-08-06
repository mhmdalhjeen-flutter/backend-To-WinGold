const Store = require("../models/store");
const StorePaymentMethod = require("../models/storePaymentMethod");
const {
  PAYMENT_METHOD_TYPES,
  ALL_PAYMENT_METHOD_DEFS,
  DEFAULT_STORE_PAYMENT_TOGGLES,
  normalizePaymentType,
  isValidPaymentType,
  normalizeAccountKind,
  resolvePaymentToggles,
  applyPaymentMethodToggles,
  buildCustomerPaymentPayload,
} = require("../utils/paymentMethodTypes.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { cleanString } = require("../utils/inputSecurity.util");

async function deactivateSiblings(storeId, type, exceptId = null) {
  const query = { store: storeId, type, isActive: true };
  if (exceptId) query._id = { $ne: exceptId };
  await StorePaymentMethod.updateMany(query, { $set: { isActive: false } });
}

async function buildPaymentSettingsForStore(storeOrId) {
  let store = storeOrId;
  if (!store || !store.paymentMethods) {
    const id = storeOrId?._id || storeOrId;
    store = await Store.findById(id).select("paymentMethods").lean();
  }
  if (!store) return { paymentSettings: {}, enabledPaymentMethods: [] };

  const toggles = resolvePaymentToggles(store.paymentMethods, DEFAULT_STORE_PAYMENT_TOGGLES);
  const activeAccounts = await StorePaymentMethod.find({
    store: store._id,
    isActive: true,
  }).lean();

  return buildCustomerPaymentPayload(toggles, activeAccounts, "barcodeImage");
}

/** @deprecated shape helper — prefer buildPaymentSettingsForStore which returns both. */
async function buildPaymentSettingsObject(storeId) {
  const { paymentSettings } = await buildPaymentSettingsForStore(storeId);
  return paymentSettings;
}

async function getActiveForStore(storeId) {
  const store = await Store.findById(storeId).select("paymentMethods").lean();
  const toggles = resolvePaymentToggles(store?.paymentMethods, DEFAULT_STORE_PAYMENT_TOGGLES);
  const accounts = await StorePaymentMethod.find({ store: storeId, isActive: true })
    .select("type accountName accountNumber accountType iban barcodeImage isActive createdAt updatedAt")
    .sort({ type: 1, createdAt: -1 })
    .lean();

  return accounts.filter((a) => {
    const type = normalizePaymentType(a.type);
    const key = type === "bank_palestine" ? "bankPalestine"
      : type === "palpay" ? "palPay"
        : type === "jawwal_pay" ? "jawwalPay"
          : null;
    return key && toggles[key]?.enabled;
  });
}

async function listForStore(storeId) {
  return StorePaymentMethod.find({ store: storeId })
    .sort({ type: 1, isActive: -1, createdAt: -1 })
    .lean();
}

async function getOwnerPaymentSettings(store) {
  const toggles = resolvePaymentToggles(store.paymentMethods, DEFAULT_STORE_PAYMENT_TOGGLES);
  const methods = await listForStore(store._id);
  return {
    paymentMethods: toggles,
    methods,
    types: PAYMENT_METHOD_TYPES,
    methodDefs: ALL_PAYMENT_METHOD_DEFS,
  };
}

async function updateStorePaymentToggles(store, paymentMethods) {
  applyPaymentMethodToggles(store, paymentMethods, DEFAULT_STORE_PAYMENT_TOGGLES);
  await store.save();
  return getOwnerPaymentSettings(store);
}

async function createForStore(storeId, body = {}) {
  const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
  const type = normalizePaymentType(rawType);
  if (!isValidPaymentType(rawType)) {
    const err = new Error("نوع الدفع غير مدعوم");
    err.status = 400;
    throw err;
  }

  const accountName = cleanString(body.accountName, { field: "accountName", max: 120, required: true });
  const accountNumber = cleanString(body.accountNumber, { field: "accountNumber", max: 64, required: true });
  const accountType = normalizeAccountKind(body.accountType);
  const iban = cleanString(body.iban, { field: "iban", max: 64 });
  const barcodeImage = body.barcodeImage
    ? await processOptionalImage(body.barcodeImage, { maxWidth: 800, enforceCloudinaryHttps: true })
    : "";

  const wantsActive = body.isActive !== false;

  if (wantsActive) {
    await deactivateSiblings(storeId, type);
  }

  return StorePaymentMethod.create({
    store: storeId,
    type,
    accountName,
    accountNumber,
    accountType,
    iban,
    barcodeImage,
    isActive: wantsActive,
  });
}

async function updateForStore(storeId, methodId, body = {}) {
  const method = await StorePaymentMethod.findOne({ _id: methodId, store: storeId });
  if (!method) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }

  if (body.type !== undefined) {
    const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
    const type = normalizePaymentType(rawType);
    if (!isValidPaymentType(rawType)) {
      const err = new Error("نوع الدفع غير مدعوم");
      err.status = 400;
      throw err;
    }
    method.type = type;
  }

  if (body.accountName !== undefined) {
    method.accountName = cleanString(body.accountName, { field: "accountName", max: 120, required: true });
  }
  if (body.accountNumber !== undefined) {
    method.accountNumber = cleanString(body.accountNumber, { field: "accountNumber", max: 64, required: true });
  }
  if (body.accountType !== undefined) {
    method.accountType = normalizeAccountKind(body.accountType);
  }
  if (body.iban !== undefined) {
    method.iban = cleanString(body.iban, { field: "iban", max: 64 });
  }
  if (body.barcodeImage !== undefined) {
    method.barcodeImage = body.barcodeImage
      ? await processOptionalImage(body.barcodeImage, {
        maxWidth: 800,
        enforceCloudinaryHttps: true,
        previousValue: method.barcodeImage,
      })
      : "";
  }

  if (body.isActive === true) {
    await deactivateSiblings(storeId, method.type, method._id);
    method.isActive = true;
  } else if (body.isActive === false) {
    method.isActive = false;
  }

  await method.save();
  return method;
}

async function activateForStore(storeId, methodId) {
  const method = await StorePaymentMethod.findOne({ _id: methodId, store: storeId });
  if (!method) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }

  await deactivateSiblings(storeId, method.type, method._id);
  method.isActive = true;
  await method.save();
  return method;
}

async function deleteForStore(storeId, methodId) {
  const result = await StorePaymentMethod.findOneAndDelete({ _id: methodId, store: storeId });
  if (!result) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }
  return result;
}

function getPaymentMethodTypes() {
  return PAYMENT_METHOD_TYPES;
}

module.exports = {
  listForStore,
  getActiveForStore,
  createForStore,
  updateForStore,
  activateForStore,
  deleteForStore,
  buildPaymentSettingsForStore,
  buildPaymentSettingsObject,
  getOwnerPaymentSettings,
  updateStorePaymentToggles,
  getPaymentMethodTypes,
};
