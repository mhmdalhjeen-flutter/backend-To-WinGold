const PlatformSubscriptionPaymentAccount = require("../models/platformSubscriptionPaymentAccount");
const {
  normalizePaymentType,
  isValidPaymentType,
  normalizeAccountKind,
  getPaymentTypeLabel,
} = require("../utils/paymentMethodTypes.util");
const { SUBSCRIPTION_PAYMENT_METHOD_TYPES } = require("../constants/storeSubscription.constants");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { cleanString } = require("../utils/inputSecurity.util");

async function deactivateSiblings(type, exceptId = null) {
  const query = { type, isActive: true };
  if (exceptId) query._id = { $ne: exceptId };
  await PlatformSubscriptionPaymentAccount.updateMany(query, { $set: { isActive: false } });
}

function toPublicAccount(account) {
  if (!account) return null;
  const plain = account.toObject ? account.toObject() : account;
  return {
    _id: plain._id,
    type: plain.type,
    label: getPaymentTypeLabel(plain.type),
    accountName: plain.accountName,
    accountNumber: plain.accountNumber,
    accountType: plain.accountType,
    iban: plain.iban || "",
    barcodeImage: plain.barcodeImage || "",
  };
}

async function listAllAccounts() {
  return PlatformSubscriptionPaymentAccount.find()
    .sort({ type: 1, isActive: -1, createdAt: -1 })
    .lean();
}

async function listActiveAccountsForStores() {
  const accounts = await PlatformSubscriptionPaymentAccount.find({
    isEnabled: true,
    isActive: true,
  })
    .sort({ type: 1, createdAt: -1 })
    .lean();
  return accounts.map(toPublicAccount);
}

async function createAccount(body = {}) {
  const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
  const type = normalizePaymentType(rawType);
  if (!type || !SUBSCRIPTION_PAYMENT_METHOD_TYPES.includes(type)) {
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
  const isEnabled = body.isEnabled !== false;
  const wantsActive = body.isActive !== false;

  if (wantsActive) {
    await deactivateSiblings(type);
  }

  return PlatformSubscriptionPaymentAccount.create({
    type,
    accountName,
    accountNumber,
    accountType,
    iban,
    barcodeImage,
    isEnabled,
    isActive: wantsActive,
  });
}

async function updateAccount(accountId, body = {}) {
  const account = await PlatformSubscriptionPaymentAccount.findById(accountId);
  if (!account) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }

  if (body.type !== undefined) {
    const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
    const type = normalizePaymentType(rawType);
    if (!isValidPaymentType(rawType) || !SUBSCRIPTION_PAYMENT_METHOD_TYPES.includes(type)) {
      const err = new Error("نوع الدفع غير مدعوم");
      err.status = 400;
      throw err;
    }
    account.type = type;
  }

  if (body.accountName !== undefined) {
    account.accountName = cleanString(body.accountName, { field: "accountName", max: 120, required: true });
  }
  if (body.accountNumber !== undefined) {
    account.accountNumber = cleanString(body.accountNumber, { field: "accountNumber", max: 64, required: true });
  }
  if (body.accountType !== undefined) account.accountType = normalizeAccountKind(body.accountType);
  if (body.iban !== undefined) account.iban = cleanString(body.iban, { field: "iban", max: 64 });
  if (body.barcodeImage !== undefined) {
    account.barcodeImage = body.barcodeImage
      ? await processOptionalImage(body.barcodeImage, { maxWidth: 800, enforceCloudinaryHttps: true })
      : "";
  }
  if (body.isEnabled !== undefined) account.isEnabled = Boolean(body.isEnabled);
  if (body.isActive !== undefined) {
    account.isActive = Boolean(body.isActive);
    if (account.isActive) await deactivateSiblings(account.type, account._id);
  }

  await account.save();
  return account;
}

async function activateAccount(accountId) {
  const account = await PlatformSubscriptionPaymentAccount.findById(accountId);
  if (!account) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }
  if (!account.isEnabled) {
    const err = new Error("لا يمكن تفعيل حساب معطّل");
    err.status = 400;
    throw err;
  }
  await deactivateSiblings(account.type, account._id);
  account.isActive = true;
  await account.save();
  return account;
}

async function deleteAccount(accountId) {
  const account = await PlatformSubscriptionPaymentAccount.findByIdAndDelete(accountId);
  if (!account) {
    const err = new Error("حساب الدفع غير موجود");
    err.status = 404;
    throw err;
  }
  return account;
}

module.exports = {
  listAllAccounts,
  listActiveAccountsForStores,
  createAccount,
  updateAccount,
  activateAccount,
  deleteAccount,
  toPublicAccount,
};
