/**
 * Pricing Service — Single Source of Truth for offer pricing.
 * All price calculations and display DTOs must go through this module.
 */

const { formatPriceWithUnit, normalizeCurrency, getCurrencySymbol } = require("../utils/currency.util");

const OFFER_TYPE_LABELS = {
  discount: "\u062E\u0635\u0645 \u0628\u0627\u0644\u0646\u0633\u0628\u0629",
  fixed_price: "\u0633\u0639\u0631 \u062B\u0627\u0628\u062A",
  fixed_discount: "\u062E\u0635\u0645 \u0628\u0642\u064A\u0645\u0629 \u062B\u0627\u0628\u062A\u0629",
  bogo: "\u0627\u0634\u062A\u0631\u0650 \u0648\u0627\u062D\u062F\u0627\u064B \u0648\u0627\u062D\u0635\u0644 \u0639\u0644\u0649 \u0622\u062E\u0631",
  free_item: "\u0647\u062F\u064A\u0629 \u0645\u0639 \u0627\u0644\u0634\u0631\u0627\u0621",
  custom: "\u0639\u0631\u0636 \u0645\u062E\u0635\u0635",
};

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function computeOfferFinalPrice({ offerType, originalPrice, value, finalPrice }) {
  const orig = toNum(originalPrice);
  const val = toNum(value);
  const direct = toNum(finalPrice);

  switch (offerType) {
    case "discount":
      if (orig == null || val == null || val < 0 || val > 100) return null;
      return Math.max(0, Math.round(orig * (1 - val / 100) * 100) / 100);
    case "fixed_price":
      if (val == null || val < 0) return null;
      return Math.round(val * 100) / 100;
    case "fixed_discount":
      if (orig == null || val == null || val < 0) return null;
      return Math.max(0, Math.round((orig - val) * 100) / 100);
    case "bogo":
      if (orig == null || orig < 0) return null;
      return Math.round((orig / 2) * 100) / 100;
    case "free_item":
      if (orig == null || orig < 0) return null;
      return Math.round(orig * 100) / 100;
    case "custom":
      if (direct == null || direct < 0) return null;
      return Math.round(direct * 100) / 100;
    default:
      return null;
  }
}

function getOfferUnitPrice(offer) {
  if (!offer) return 0;
  const stored = toNum(offer.finalPrice);
  if (stored != null) return stored;
  return computeOfferFinalPrice(offer) ?? toNum(offer.value) ?? 0;
}

/** إجمالي سطر السلة/الطلب — BOGO: ادفع مقابل ceil(qty/2) وحدة */
function computeOfferLineTotal(offer, quantity) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty === 0) return 0;

  const offerType = offer?.offerType;
  const orig = toNum(offer?.originalPrice);
  const unitPrice = getOfferUnitPrice(offer);

  if (offerType === "bogo") {
    const singlePrice = orig ?? unitPrice * 2;
    if (singlePrice == null || singlePrice < 0) return 0;
    const paidUnits = Math.ceil(qty / 2);
    return Math.round(paidUnits * singlePrice * 100) / 100;
  }

  return Math.round(unitPrice * qty * 100) / 100;
}

function formatOfferBadge(offer) {
  if (!offer) return "";
  switch (offer.offerType) {
    case "discount":
      return offer.value != null
        ? `\u062E\u0635\u0645 ${offer.value}%`
        : "\u062E\u0635\u0645";
    case "fixed_price":
      return "\u0633\u0639\u0631 \u062E\u0627\u0635";
    case "fixed_discount":
      return offer.value != null
        ? `\u062E\u0635\u0645 ${offer.value} ${getCurrencySymbol(offer.currency)}`
        : "\u062E\u0635\u0645 \u062B\u0627\u0628\u062A";
    case "bogo":
      return "1+1";
    case "free_item":
      return "\u0647\u062F\u064A\u0629";
    case "custom":
      return "\u0639\u0631\u0636";
    default:
      return "\u0639\u0631\u0636";
  }
}

function resolveOfferPrices(offer) {
  if (!offer) {
    return { oldPrice: null, newPrice: null, showCompare: false };
  }

  const oldPrice = toNum(offer.originalPrice);
  let newPrice = toNum(offer.finalPrice);

  if (newPrice == null) {
    newPrice = computeOfferFinalPrice({
      offerType: offer.offerType,
      originalPrice: offer.originalPrice,
      value: offer.value,
      finalPrice: offer.finalPrice,
    });
  }

  if (offer.offerType === "bogo" && oldPrice != null && newPrice == null) {
    newPrice = Math.round((oldPrice / 2) * 100) / 100;
  }

  const showCompare = oldPrice != null && newPrice != null && oldPrice > newPrice;

  return { oldPrice, newPrice, showCompare };
}

/** Display DTO for API responses — frontends should render this, not recalculate. */
function buildOfferPricingDTO(offer) {
  const { oldPrice, newPrice, showCompare } = resolveOfferPrices(offer);
  const badge = formatOfferBadge(offer);
  const unitPrice = getOfferUnitPrice(offer);
  const currency = normalizeCurrency(offer?.currency);
  const priceUnit = offer?.priceUnit || null;

  return {
    originalPrice: oldPrice,
    finalPrice: newPrice,
    unitPrice,
    showCompare,
    badge,
    currency,
    priceUnit,
    displayOld: oldPrice != null ? formatPriceWithUnit(oldPrice, currency, priceUnit) : null,
    displayNew: newPrice != null ? formatPriceWithUnit(newPrice, currency, priceUnit) : null,
    offerType: offer?.offerType || null,
    offerTypeLabel: OFFER_TYPE_LABELS[offer?.offerType] || offer?.offerType || null,
  };
}

function attachPricingToOffer(offer) {
  if (!offer) return offer;
  const plain = typeof offer.toObject === "function" ? offer.toObject() : { ...offer };
  return { ...plain, pricing: buildOfferPricingDTO(plain) };
}

module.exports = {
  OFFER_TYPE_LABELS,
  computeOfferFinalPrice,
  computeOfferLineTotal,
  getOfferUnitPrice,
  formatOfferBadge,
  resolveOfferPrices,
  buildOfferPricingDTO,
  attachPricingToOffer,
};
