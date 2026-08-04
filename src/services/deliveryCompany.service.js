const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../models/deliveryCompanyPaymentAccount");
const { SETTINGS_KEY_BY_TYPE } = require("../utils/paymentMethodTypes.util");

const CUSTOMER_METHOD_IDS = {
  cashOnDelivery: "cash_on_delivery",
  bankPalestine: "bank_palestine",
  palPay: "palpay",
  jawwalPay: "jawwal_pay",
};

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function ensureUniqueSlug(base, exceptId = null) {
  let slug = slugify(base) || `delivery-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (true) {
    const query = { slug: candidate, deletedAt: null };
    if (exceptId) query._id = { $ne: exceptId };
    const exists = await DeliveryCompany.exists(query);
    if (!exists) return candidate;
    candidate = `${slug}-${i}`;
    i += 1;
  }
}

async function deactivateAccountSiblings(companyId, type, exceptId = null) {
  const query = { deliveryCompany: companyId, type, isActive: true };
  if (exceptId) query._id = { $ne: exceptId };
  await DeliveryCompanyPaymentAccount.updateMany(query, { $set: { isActive: false } });
}

async function listPaymentAccounts(companyId) {
  return DeliveryCompanyPaymentAccount.find({ deliveryCompany: companyId })
    .sort({ type: 1, isActive: -1, createdAt: -1 })
    .lean();
}

function buildPaymentSettingsFromAccounts(paymentMethods = {}, accounts = []) {
  const settings = {
    cashOnDelivery: {
      enabled: paymentMethods.cashOnDelivery?.enabled !== false,
    },
    bankPalestine: { enabled: Boolean(paymentMethods.bankPalestine?.enabled) },
    palPay: { enabled: Boolean(paymentMethods.palPay?.enabled) },
    jawwalPay: { enabled: Boolean(paymentMethods.jawwalPay?.enabled) },
  };

  for (const account of accounts.filter((a) => a.isActive)) {
    const key = SETTINGS_KEY_BY_TYPE[account.type];
    if (!key || key === "cashOnDelivery") continue;
    settings[key] = {
      enabled: settings[key]?.enabled !== false,
      qrCodeUrl: account.qrCodeUrl || "",
      accountOwnerName: account.accountName || "",
      accountNumber: account.accountNumber || "",
      iban: account.iban || "",
    };
  }

  return settings;
}

function buildEnabledPaymentMethods(paymentSettings) {
  const enabled = [];
  if (paymentSettings.cashOnDelivery?.enabled !== false) {
    enabled.push(CUSTOMER_METHOD_IDS.cashOnDelivery);
  }

  const digitalKeys = [
    ["bankPalestine", CUSTOMER_METHOD_IDS.bankPalestine],
    ["palPay", CUSTOMER_METHOD_IDS.palPay],
    ["jawwalPay", CUSTOMER_METHOD_IDS.jawwalPay],
  ];

  digitalKeys.forEach(([settingsKey, methodId]) => {
    const entry = paymentSettings[settingsKey];
    if (entry?.enabled === false) return;
    const configured = Boolean(
      entry?.qrCodeUrl || entry?.accountOwnerName || entry?.accountNumber,
    );
    if (configured) enabled.push(methodId);
  });

  return enabled;
}

function toAdminCompany(company, accounts = []) {
  const plain = company.toObject ? company.toObject() : { ...company };
  const servedRegionIds = (plain.servedRegionIds || []).map(String);
  return {
    ...plain,
    servedRegionIds,
    coverageCount: plain.servesAllRegions ? 0 : servedRegionIds.length,
    paymentAccounts: accounts.map((a) => ({
      _id: a._id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      iban: a.iban || "",
      qrCodeUrl: a.qrCodeUrl || "",
      isActive: Boolean(a.isActive),
    })),
  };
}

function toCustomerCompany(company, accounts = []) {
  const plain = company.toObject ? company.toObject() : { ...company };
  const paymentSettings = buildPaymentSettingsFromAccounts(plain.paymentMethods, accounts);
  const enabledPaymentMethods = buildEnabledPaymentMethods(paymentSettings);

  return {
    id: plain.slug || String(plain._id),
    _id: plain._id,
    name: plain.nameEn || plain.name,
    nameAr: plain.name,
    phone: plain.phone,
    whatsapp: plain.whatsapp || "",
    description: plain.description || "",
    logo: plain.logo || null,
    basePrice: plain.basePrice,
    extraOrderPrice: plain.extraOrderPrice,
    currency: plain.currency || "ILS",
    servedRegionIds: (plain.servedRegionIds || []).map(String),
    servesAllRegions: Boolean(plain.servesAllRegions),
    enabledPaymentMethods,
    paymentSettings,
  };
}

async function loadCompanyWithAccounts(companyId) {
  const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null });
  if (!company) return null;
  const accounts = await listPaymentAccounts(company._id);
  return { company, accounts };
}

module.exports = {
  slugify,
  ensureUniqueSlug,
  deactivateAccountSiblings,
  listPaymentAccounts,
  buildPaymentSettingsFromAccounts,
  buildEnabledPaymentMethods,
  toAdminCompany,
  toCustomerCompany,
  loadCompanyWithAccounts,
  CUSTOMER_METHOD_IDS,
};
