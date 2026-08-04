/**
 * حساب نقاط ترتيب العرض — يوازن بين التقييم، الحداثة، والأولوية
 * دون إقصاء المتاجر/العروض الجديدة (Bayesian smoothing).
 */

const {
  applyOfferDisplayPrioritySort,
  getOfferDisplayPriority,
  hasDisplayPriority,
  OFFER_LEGACY_FIELD,
} = require("./displayPriority.util");

const PRIOR_RATING = 3.5;
const PRIOR_WEIGHT = 8;

function bayesianRating(avg = 0, count = 0) {
  const c = Number(count) || 0;
  const a = Number(avg) || 0;
  return (a * c + PRIOR_RATING * PRIOR_WEIGHT) / (c + PRIOR_WEIGHT);
}

function freshnessBoost(createdAt) {
  if (!createdAt) return 0;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 3) return 15;
  if (ageDays <= 7) return 10;
  if (ageDays <= 14) return 5;
  if (ageDays <= 30) return 2;
  return 0;
}

function offerQualityBoost(offer = {}) {
  let boost = 0;
  if (offer.isFeatured) boost += 8;
  if (offer.isExtended) boost += 3;
  const discount = Number(offer.value) || 0;
  if (offer.offerType === "discount" && discount >= 20) boost += 4;
  if (offer.offerType === "free_item") boost += 5;
  return boost;
}

function computeOfferRankScore(offer, store) {
  const offerRating = bayesianRating(offer.ratingAvg, offer.ratingCount);
  const storeRating = bayesianRating(store?.ratingAvg, store?.ratingCount);
  const blendedRating = offerRating * 0.6 + storeRating * 0.4;

  const reviewSignal = Math.log10((Number(offer.ratingCount) || 0) + (Number(store?.ratingCount) || 0) + 1);
  const engagement = Math.log10((Number(offer.views) || 0) + (Number(offer.clicks) || 0) * 2 + 1) * 4;

  return (
    (Number(offer.priority) || 0) * 100 +
    blendedRating * 25 +
    reviewSignal * 12 +
    engagement +
    freshnessBoost(offer.createdAt) +
    offerQualityBoost(offer)
  );
}

function hasFeaturedPriority(offer) {
  return hasDisplayPriority(offer, OFFER_LEGACY_FIELD);
}

/** يضع العروض ذات displayPriority أولاً (1، 2، 3…) ثم يكمل بالترتيب الحالي */
function applyFeaturedPrioritySort(offers = [], sortFn) {
  return applyOfferDisplayPrioritySort(offers, sortFn);
}

function sortOffersByRank(offers = []) {
  const rankAuto = (list) =>
    [...list].sort((a, b) => {
      const scoreA = a._rankScore ?? computeOfferRankScore(a, a.store);
      const scoreB = b._rankScore ?? computeOfferRankScore(b, b.store);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  return applyFeaturedPrioritySort(offers, rankAuto);
}

module.exports = {
  bayesianRating,
  computeOfferRankScore,
  sortOffersByRank,
  applyFeaturedPrioritySort,
  hasFeaturedPriority,
  getOfferDisplayPriority,
  freshnessBoost,
};
