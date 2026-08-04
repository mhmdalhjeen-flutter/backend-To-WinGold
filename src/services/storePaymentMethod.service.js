const StorePaymentMethod = require("../models/storePaymentMethod");
const {
  PAYMENT_METHOD_TYPES,
  SETTINGS_KEY_BY_TYPE,
  normalizePaymentType,
  isValidPaymentType,
} = require("../utils/paymentMethodTypes.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { cleanString } = require("../utils/inputSecurity.util");

async function deactivateSiblings(storeId, type, exceptId = null) {
  const query = { store: storeId, type, isActive: true };
  if (exceptId) query._id = { $ne: exceptId };
  await StorePaymentMethod.updateMany(query, { $set: { isActive: false } });
}

/**
 * Build customer-facing paymentSettings from active accounts (one per type).
 */
async function buildPaymentSettingsForStore(storeId) {
  const activeAccounts = await StorePaymentMethod.find({
    store: storeId,
    isActive: true,
  }).lean();

  const settings = {};
  for (const account of activeAccounts) {
    const key = SETTINGS_KEY_BY_TYPE[account.type];
    if (!key) continue;
    settings[key] = {
      enabled: true,
      qrCodeUrl: account.barcodeImage || "",
      accountOwnerName: account.accountName || "",
      accountNumber: account.accountNumber || "",
      iban: account.iban || "",
    };
  }
  return settings;
}

async function getActiveForStore(storeId) {
  return StorePaymentMethod.find({ store: storeId, isActive: true })
    .select("type accountName accountNumber iban barcodeImage isActive createdAt updatedAt")
    .sort({ type: 1, createdAt: -1 })
    .lean();
}

async function listForStore(storeId) {
  return StorePaymentMethod.find({ store: storeId })
    .sort({ type: 1, isActive: -1, createdAt: -1 })
    .lean();
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
  getPaymentMethodTypes,
};
