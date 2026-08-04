const UserActivity = require("../models/userActivity");
const {
  computeOfferRankScore,
  sortOffersByRank,
  applyFeaturedPrioritySort,
  bayesianRating,
  freshnessBoost,
} = require("./ranking.util");

async function buildUserSignals(userId) {
  if (!userId) return null;

  const activities = await UserActivity.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(80)
    .lean();

  const categoryScore = {};
  const regionScore = {};
  const searchTerms = [];

  for (const a of activities) {
    const weight = a.type === "favorite_offer" ? 3 : a.type === "open_offer" ? 2 : 1;
    if (a.meta?.category) categoryScore[a.meta.category] = (categoryScore[a.meta.category] || 0) + weight;
    if (a.meta?.region) regionScore[a.meta.region] = (regionScore[a.meta.region] || 0) + weight;
    if (a.type === "search" && a.meta?.query) searchTerms.push(String(a.meta.query));
  }

  const hasSignals =
    Object.keys(categoryScore).length > 0 ||
    Object.keys(regionScore).length > 0 ||
    searchTerms.length > 0;

  return { categoryScore, regionScore, searchTerms, hasSignals };
}

function computePersonalizedScore(offer, store, signals) {
  const base = computeOfferRankScore(offer, store);

  if (!signals?.hasSignals) {
    const rating = bayesianRating(offer.ratingAvg, offer.ratingCount);
    const storeRating = bayesianRating(store?.ratingAvg, store?.ratingCount);
    const blended = rating * 0.6 + storeRating * 0.4;
    return blended * 30 + freshnessBoost(offer.createdAt) * 2 + base * 0.3;
  }

  let interest = 0;
  const cat = store?.category;
  const reg = store?.region;
  if (cat && signals.categoryScore[cat]) interest += signals.categoryScore[cat] * 8;
  if (reg && signals.regionScore[reg]) interest += signals.regionScore[reg] * 6;
  if (signals.searchTerms.some((t) => offer.title && offer.title.includes(t))) interest += 10;

  return base + interest;
}

function sortOffersPersonalized(offers, signals) {
  const rankAuto = (list) =>
    [...list]
      .map((o) => ({
        ...o,
        _rankScore: computePersonalizedScore(o, o.store, signals),
      }))
      .sort((a, b) => {
        if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

  return applyFeaturedPrioritySort(offers, rankAuto);
}

module.exports = { buildUserSignals, computePersonalizedScore, sortOffersPersonalized, sortOffersByRank };
