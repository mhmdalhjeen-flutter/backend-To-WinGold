/** Unified payment method registry for stores and delivery companies. */

const ACCOUNT_KINDS = Object.freeze(["merchant", "personal"]);

const ACCOUNT_KIND_LABELS = Object.freeze({
  merchant: "تاجر",
  personal: "شخصي",
});

/** Non-account methods (toggle only). */
const SIMPLE_PAYMENT_METHODS = [
  {
    id: "cash_on_delivery",
    settingsKey: "cashOnDelivery",
    labelAr: "الدفع عند التوصيل",
    requiresAccount: false,
  },
  {
    id: "seller_agreement",
    settingsKey: "agreementWithStore",
    labelAr: "الاتفاق مع البائع",
    requiresAccount: false,
  },
];

/** Digital methods that require payment accounts. */
const PAYMENT_METHOD_TYPES = [
  {
    id: "bank_palestine",
    settingsKey: "bankPalestine",
    labelAr: "بنك فلسطين",
    requiresAccount: true,
  },
  {
    id: "palpay",
    settingsKey: "palPay",
    labelAr: "PalPay",
    requiresAccount: true,
  },
  {
    id: "jawwal_pay",
    settingsKey: "jawwalPay",
    labelAr: "Jawwal Pay",
    requiresAccount: true,
  },
];

/** All methods shown in Payment Settings UI (order matters). */
const ALL_PAYMENT_METHOD_DEFS = [...SIMPLE_PAYMENT_METHODS, ...PAYMENT_METHOD_TYPES];

/** Canonical digital type ids + legacy `bank`. */
const PAYMENT_TYPE_IDS = [...PAYMENT_METHOD_TYPES.map((t) => t.id), "bank"];

const PAYMENT_TYPE_ALIASES = {
  bank: "bank_palestine",
  bank_palestine: "bank_palestine",
  palpay: "palpay",
  jawwal_pay: "jawwal_pay",
};

const SETTINGS_KEY_BY_TYPE = Object.fromEntries(
  ALL_PAYMENT_METHOD_DEFS.map((t) => [t.id, t.settingsKey]),
);

const CUSTOMER_ID_BY_SETTINGS_KEY = Object.fromEntries(
  ALL_PAYMENT_METHOD_DEFS.map((t) => [t.settingsKey, t.id]),
);

const TOGGLE_KEYS = ALL_PAYMENT_METHOD_DEFS.map((t) => t.settingsKey);

/** Default toggles for store owners (legacy-friendly: all on until disabled). */
const DEFAULT_STORE_PAYMENT_TOGGLES = Object.freeze({
  cashOnDelivery: { enabled: true },
  agreementWithStore: { enabled: true },
  bankPalestine: { enabled: true },
  palPay: { enabled: true },
  jawwalPay: { enabled: true },
});

/** Default toggles for delivery companies. */
const DEFAULT_DELIVERY_PAYMENT_TOGGLES = Object.freeze({
  cashOnDelivery: { enabled: true },
  agreementWithStore: { enabled: false },
  bankPalestine: { enabled: false },
  palPay: { enabled: false },
  jawwalPay: { enabled: false },
});

function normalizePaymentType(type) {
  if (!type) return "";
  const key = String(type).trim().toLowerCase();
  return PAYMENT_TYPE_ALIASES[key] || (PAYMENT_TYPE_IDS.includes(key) ? key : "");
}

function isValidPaymentType(type) {
  return Boolean(normalizePaymentType(type));
}

function getPaymentTypeLabel(type) {
  const normalized = normalizePaymentType(type) || type;
  return (
    ALL_PAYMENT_METHOD_DEFS.find((t) => t.id === normalized)?.labelAr
    || PAYMENT_METHOD_TYPES.find((t) => t.id === normalized)?.labelAr
    || type
  );
}

function normalizeAccountKind(value) {
  const v = String(value || "merchant").toLowerCase().trim();
  return ACCOUNT_KINDS.includes(v) ? v : "merchant";
}

/**
 * Resolve toggle map with defaults. Undefined keys fall back to defaultEnabled.
 */
function resolvePaymentToggles(paymentMethods, defaults = DEFAULT_STORE_PAYMENT_TOGGLES) {
  const pm = paymentMethods || {};
  const result = {};
  for (const key of TOGGLE_KEYS) {
    const fallback = defaults[key]?.enabled !== false;
    if (pm[key]?.enabled === undefined) {
      result[key] = { enabled: fallback };
    } else {
      result[key] = { enabled: Boolean(pm[key].enabled) };
    }
  }
  return result;
}

/**
 * Apply toggle patch onto a mongoose subdocument / plain object.
 */
function applyPaymentMethodToggles(target, paymentMethods = {}, defaults = DEFAULT_STORE_PAYMENT_TOGGLES) {
  if (!paymentMethods || typeof paymentMethods !== "object") return;
  if (!target.paymentMethods) target.paymentMethods = {};
  for (const key of TOGGLE_KEYS) {
    if (paymentMethods[key]?.enabled === undefined) continue;
    target.paymentMethods[key] = { enabled: Boolean(paymentMethods[key].enabled) };
  }
  // Ensure all keys exist after patch
  const resolved = resolvePaymentToggles(target.paymentMethods, defaults);
  for (const key of TOGGLE_KEYS) {
    if (!target.paymentMethods[key]) {
      target.paymentMethods[key] = { enabled: resolved[key].enabled };
    }
  }
  if (typeof target.markModified === "function") {
    target.markModified("paymentMethods");
  }
}

/**
 * Build customer-facing paymentSettings + enabledPaymentMethods.
 * Only enabled methods are included. Digital methods need an active account.
 *
 * @param {object} toggles - resolved toggles
 * @param {Array} activeAccounts - active accounts only
 * @param {'barcodeImage'|'qrCodeUrl'} qrField
 */
function buildCustomerPaymentPayload(toggles, activeAccounts = [], qrField = "barcodeImage") {
  const paymentSettings = {};
  const enabledPaymentMethods = [];

  for (const def of SIMPLE_PAYMENT_METHODS) {
    const key = def.settingsKey;
    if (!toggles[key]?.enabled) continue;
    paymentSettings[key] = { enabled: true };
    enabledPaymentMethods.push(def.id);
  }

  const accountsByType = new Map();
  for (const account of activeAccounts) {
    const type = normalizePaymentType(account.type);
    if (!type || accountsByType.has(type)) continue;
    accountsByType.set(type, account);
  }

  for (const def of PAYMENT_METHOD_TYPES) {
    const key = def.settingsKey;
    if (!toggles[key]?.enabled) continue;
    const account = accountsByType.get(def.id);
    if (!account) continue;

    const qr = account[qrField] || account.qrCodeUrl || account.barcodeImage || "";
    paymentSettings[key] = {
      enabled: true,
      qrCodeUrl: qr,
      accountOwnerName: account.accountName || "",
      accountNumber: account.accountNumber || "",
      accountType: normalizeAccountKind(account.accountType),
      iban: account.iban || "",
    };
    enabledPaymentMethods.push(def.id);
  }

  return { paymentSettings, enabledPaymentMethods };
}

module.exports = {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  SIMPLE_PAYMENT_METHODS,
  PAYMENT_METHOD_TYPES,
  ALL_PAYMENT_METHOD_DEFS,
  PAYMENT_TYPE_IDS,
  PAYMENT_TYPE_ALIASES,
  SETTINGS_KEY_BY_TYPE,
  CUSTOMER_ID_BY_SETTINGS_KEY,
  TOGGLE_KEYS,
  DEFAULT_STORE_PAYMENT_TOGGLES,
  DEFAULT_DELIVERY_PAYMENT_TOGGLES,
  normalizePaymentType,
  isValidPaymentType,
  getPaymentTypeLabel,
  normalizeAccountKind,
  resolvePaymentToggles,
  applyPaymentMethodToggles,
  buildCustomerPaymentPayload,
};
