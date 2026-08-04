/** Supported digital payment method types — extensible registry. */
const PAYMENT_METHOD_TYPES = [
  {
    id: "bank_palestine",
    settingsKey: "bankPalestine",
    labelAr: "بنك فلسطين",
  },
  {
    id: "palpay",
    settingsKey: "palPay",
    labelAr: "PalPay",
  },
  {
    id: "jawwal_pay",
    settingsKey: "jawwalPay",
    labelAr: "Jawwal Pay",
  },
];

/** Canonical `bank` plus legacy `bank_palestine` for backward compatibility. */
const PAYMENT_TYPE_IDS = [...PAYMENT_METHOD_TYPES.map((t) => t.id), "bank"];

const PAYMENT_TYPE_ALIASES = {
  bank: "bank_palestine",
  bank_palestine: "bank_palestine",
};

const SETTINGS_KEY_BY_TYPE = Object.fromEntries(
  PAYMENT_METHOD_TYPES.map((t) => [t.id, t.settingsKey]),
);

function normalizePaymentType(type) {
  if (!type) return "";
  const key = String(type).trim().toLowerCase();
  return PAYMENT_TYPE_ALIASES[key] || (PAYMENT_TYPE_IDS.includes(key) ? key : "");
}

function isValidPaymentType(type) {
  return Boolean(normalizePaymentType(type));
}

function getPaymentTypeLabel(type) {
  return PAYMENT_METHOD_TYPES.find((t) => t.id === type)?.labelAr || type;
}

module.exports = {
  PAYMENT_METHOD_TYPES,
  PAYMENT_TYPE_IDS,
  PAYMENT_TYPE_ALIASES,
  SETTINGS_KEY_BY_TYPE,
  normalizePaymentType,
  isValidPaymentType,
  getPaymentTypeLabel,
};
