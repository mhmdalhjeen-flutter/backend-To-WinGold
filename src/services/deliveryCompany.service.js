const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../models/deliveryCompanyPaymentAccount");
const {
  DEFAULT_DELIVERY_PAYMENT_TOGGLES,
  resolvePaymentToggles,
  buildCustomerPaymentPayload,
  normalizeAccountKind,
} = require("../utils/paymentMethodTypes.util");

const CUSTOMER_METHOD_IDS = {
  cashOnDelivery: "cash_on_delivery",
  agreementWithStore: "seller_agreement",
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
  const toggles = resolvePaymentToggles(paymentMethods, DEFAULT_DELIVERY_PAYMENT_TOGGLES);
  const activeAccounts = (accounts || []).filter((a) => a.isActive);
  return buildCustomerPaymentPayload(toggles, activeAccounts, "qrCodeUrl").paymentSettings;
}

function buildEnabledPaymentMethods(paymentSettings) {
  const enabled = [];
  if (paymentSettings.cashOnDelivery?.enabled) {
    enabled.push(CUSTOMER_METHOD_IDS.cashOnDelivery);
  }
  if (paymentSettings.agreementWithStore?.enabled) {
    enabled.push(CUSTOMER_METHOD_IDS.agreementWithStore);
  }

  const digitalKeys = [
    ["bankPalestine", CUSTOMER_METHOD_IDS.bankPalestine],
    ["palPay", CUSTOMER_METHOD_IDS.palPay],
    ["jawwalPay", CUSTOMER_METHOD_IDS.jawwalPay],
  ];

  digitalKeys.forEach(([settingsKey, methodId]) => {
    const entry = paymentSettings[settingsKey];
    if (!entry?.enabled) return;
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
  const paymentMethods = resolvePaymentToggles(plain.paymentMethods, DEFAULT_DELIVERY_PAYMENT_TOGGLES);
  return {
    ...plain,
    paymentMethods,
    servedRegionIds,
    coverageCount: plain.servesAllRegions ? 0 : servedRegionIds.length,
    handedOverOrderCount: Math.max(0, Number(plain.handedOverOrderCount) || 0),
    paymentAccounts: accounts.map((a) => ({
      _id: a._id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      accountType: normalizeAccountKind(a.accountType),
      iban: a.iban || "",
      qrCodeUrl: a.qrCodeUrl || "",
      isActive: Boolean(a.isActive),
    })),
  };
}

function toCustomerCompany(company, accounts = [], options = {}) {
  const plain = company.toObject ? company.toObject() : { ...company };
  const toggles = resolvePaymentToggles(plain.paymentMethods, DEFAULT_DELIVERY_PAYMENT_TOGGLES);
  const activeAccounts = (accounts || []).filter((a) => a.isActive);
  const { paymentSettings, enabledPaymentMethods } = buildCustomerPaymentPayload(
    toggles,
    activeAccounts,
    "qrCodeUrl",
  );
  const servedRegionIds = (plain.servedRegionIds || []).map(String);
  const regionNames = options.regionNames || {};
  const servedRegionNames = plain.servesAllRegions
    ? []
    : servedRegionIds
      .map((id) => regionNames[String(id)] || "")
      .filter(Boolean);

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
    servedRegionIds,
    servedRegionNames,
    servesAllRegions: Boolean(plain.servesAllRegions),
    enabledPaymentMethods,
    paymentSettings,
    isRecommended: Boolean(options.isRecommended),
    recommendedForRegion: Boolean(options.recommendedForRegion),
  };
}

function isCompanyRecommendedForRegion(company, regionId) {
  if (!regionId) return false;
  if (company.servesAllRegions) return true;
  const ids = (company.servedRegionIds || []).map(String);
  return ids.includes(String(regionId));
}

/** Sort companies: recommended for region first, then by name. Never filters. */
function sortCompaniesByRegionRecommendation(companies, regionId, options = {}) {
  const { regionNames = {} } = options;
  if (!regionId) {
    return companies.map((c) => toCustomerCompany(c.company || c, c.accounts || [], { isRecommended: false, regionNames }));
  }

  const rid = String(regionId);
  const ranked = companies.map((entry) => {
    const company = entry.company || entry;
    const accounts = entry.accounts || [];
    const recommended = isCompanyRecommendedForRegion(company, rid);
    return { company, accounts, recommended, sortName: (company.nameAr || company.name || "").toLowerCase() };
  });

  ranked.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.sortName.localeCompare(b.sortName, "ar");
  });

  return ranked.map(({ company, accounts, recommended }) =>
    toCustomerCompany(company, accounts, { isRecommended: recommended, recommendedForRegion: recommended, regionNames }));
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
  isCompanyRecommendedForRegion,
  sortCompaniesByRegionRecommendation,
  CUSTOMER_METHOD_IDS,
};
