/**
 * طبقة أولوية عرض يدوية اختيارية — لا تستبدل نظام التوصيات.
 * displayPriority أقل = يظهر أولاً. null = السلوك الحالي دون تغيير.
 */

const OFFER_LEGACY_FIELD = "featuredPriority";

function getDisplayPriority(item, legacyField = null) {
  const dp = item?.displayPriority;
  if (dp != null && dp !== "" && Number.isFinite(Number(dp))) {
    return Number(dp);
  }
  if (legacyField) {
    const legacy = item?.[legacyField];
    if (legacy != null && legacy !== "" && Number.isFinite(Number(legacy))) {
      return Number(legacy);
    }
  }
  return null;
}

function hasDisplayPriority(item, legacyField = null) {
  return getDisplayPriority(item, legacyField) != null;
}

function compareDisplayPriority(a, b, legacyField = null) {
  const pa = getDisplayPriority(a, legacyField);
  const pb = getDisplayPriority(b, legacyField);
  const aHas = pa != null;
  const bHas = pb != null;
  if (aHas && bHas) return pa - pb;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  return 0;
}

/** يضع العناصر ذات displayPriority أولاً (1، 2، 3…) ثم يكمل بترتيب التوصيات */
function applyDisplayPrioritySort(items = [], autoSortFn, legacyField = null) {
  const manual = [];
  const auto = [];

  for (const item of items) {
    if (hasDisplayPriority(item, legacyField)) manual.push(item);
    else auto.push(item);
  }

  manual.sort(
    (a, b) => getDisplayPriority(a, legacyField) - getDisplayPriority(b, legacyField)
  );
  const rankedAuto = typeof autoSortFn === "function" ? autoSortFn(auto) : auto;
  return [...manual, ...rankedAuto];
}

function sortWithDisplayPriorityThen(items = [], fallbackCompare, legacyField = null) {
  return [...items].sort((a, b) => {
    const pri = compareDisplayPriority(a, b, legacyField);
    if (pri !== 0) return pri;
    return fallbackCompare(a, b);
  });
}

function getOfferDisplayPriority(offer) {
  return getDisplayPriority(offer, OFFER_LEGACY_FIELD);
}

function applyOfferDisplayPrioritySort(offers = [], autoSortFn) {
  return applyDisplayPrioritySort(offers, autoSortFn, OFFER_LEGACY_FIELD);
}

function sortProductsByDefault(products = []) {
  return [...products].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
}

function applyProductDisplayPrioritySort(products = [], autoSortFn = sortProductsByDefault) {
  return applyDisplayPrioritySort(products, autoSortFn);
}

module.exports = {
  OFFER_LEGACY_FIELD,
  getDisplayPriority,
  hasDisplayPriority,
  compareDisplayPriority,
  applyDisplayPrioritySort,
  sortWithDisplayPriorityThen,
  getOfferDisplayPriority,
  applyOfferDisplayPrioritySort,
  sortProductsByDefault,
  applyProductDisplayPrioritySort,
};
