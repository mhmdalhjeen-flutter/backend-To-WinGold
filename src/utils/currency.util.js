const DEFAULT_CURRENCY = "ILS";

const CURRENCY_SYMBOLS = {
  ILS: "₪",
  JOD: "JD",
  USD: "$",
};

const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

function normalizeCurrency(code) {
  const raw = String(code || DEFAULT_CURRENCY).trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(raw) ? raw : DEFAULT_CURRENCY;
}

function getCurrencySymbol(code) {
  return CURRENCY_SYMBOLS[normalizeCurrency(code)];
}

function formatPrice(amount, currency = DEFAULT_CURRENCY) {
  const symbol = getCurrencySymbol(currency);
  if (amount == null || amount === "") return `${symbol} 0`;
  const num = Number(amount);
  const value = Number.isFinite(num)
    ? num.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : amount;
  return `${symbol} ${value}`;
}

function formatPriceWithUnit(amount, currency, priceUnit) {
  const base = formatPrice(amount, currency);
  const unit = String(priceUnit || "").trim();
  return unit ? `${base} / ${unit}` : base;
}

module.exports = {
  DEFAULT_CURRENCY,
  CURRENCY_SYMBOLS,
  SUPPORTED_CURRENCIES,
  normalizeCurrency,
  getCurrencySymbol,
  formatPrice,
  formatPriceWithUnit,
};
