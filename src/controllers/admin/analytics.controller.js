const User = require("../../models/user");
const Store = require("../../models/store");
const Offer = require("../../models/offer");
const UserActivity = require("../../models/userActivity");
const ActivityLog = require("../../models/ActivityLog");
const Competition = require("../../models/competition");
const analytics = require("../../services/adminAnalytics.service");
const {
  normalizePeriod,
  getPeriodBounds,
  growthRate,
  buildDailySeries,
  buildMonthlySeries,
} = require("../../utils/analyticsPeriod.util");

async function countInRange(Model, match, start, end) {
  return Model.countDocuments({ ...match, createdAt: { $gte: start, $lte: end } });
}

async function activityCountInRange(start, end) {
  return UserActivity.countDocuments({ createdAt: { $gte: start, $lte: end } });
}

async function dailyActivitySeries(start, end) {
  const rows = await UserActivity.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        count: { $sum: 1 },
      },
    },
  ]);

  return buildDailySeries(rows, start, end);
}

async function monthlyActivitySeries() {
  const since = new Date();
  since.setMonth(since.getMonth() - 11);
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const rows = await UserActivity.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
        count: { $sum: 1 },
      },
    },
  ]);

  return buildMonthlySeries(rows, 12);
}

async function topCompetitions(start, end, limit = 10) {
  const rows = await Competition.aggregate([
    { $unwind: { path: "$participants", preserveNullAndEmptyArrays: false } },
    { $match: { "participants.joinedAt": { $gte: start, $lte: end } } },
    {
      $group: {
        _id: "$_id",
        title: { $first: "$title" },
        participants: { $sum: 1 },
        entries: { $sum: "$participants.entriesCount" },
      },
    },
    { $sort: { entries: -1, participants: -1 } },
    { $limit: limit },
  ]);

  if (rows.length) return rows;

  return Competition.find()
    .sort({ totalEntries: -1 })
    .limit(limit)
    .select("title totalEntries participants")
    .lean()
    .then((items) =>
      items.map((c) => ({
        _id: c._id,
        title: c.title,
        participants: c.participants?.length || 0,
        entries: c.totalEntries || 0,
        source: "allTime",
      }))
    );
}

exports.getAnalytics = async (req, res) => {
  try {
    const period = normalizePeriod(req.query.period);
    const { start, end, prevStart, prevEnd } = getPeriodBounds(period);

    const [
      newUsers,
      prevNewUsers,
      newStores,
      prevNewStores,
      newOffers,
      prevNewOffers,
      activityCurrent,
      activityPrevious,
      dailyActivity,
      monthlyActivity,
      usageData,
      ordersRegions,
      prizeRegions,
      topStoresVisits,
      topStoresOrders,
      topStoresPromo,
      topProductsViews,
      topProductsOrders,
      topOffersViews,
      topOffersOrders,
      topRatedProducts,
      topRatedOffers,
      topCompetitionsList,
    ] = await Promise.all([
      countInRange(User, { role: "customer" }, start, end),
      countInRange(User, { role: "customer" }, prevStart, prevEnd),
      countInRange(Store, {}, start, end),
      countInRange(Store, {}, prevStart, prevEnd),
      countInRange(Offer, {}, start, end),
      countInRange(Offer, {}, prevStart, prevEnd),
      activityCountInRange(start, end),
      activityCountInRange(prevStart, prevEnd),
      dailyActivitySeries(start, end),
      monthlyActivitySeries(),
      analytics.regionUsageScores(start, end),
      analytics.ordersByRegion(start, end),
      analytics.prizeWinsByRegion(start, end),
      analytics.topStoresByVisits(start, end),
      analytics.topStoresByOrders(start, end),
      analytics.topStoresByPromoCodes(start, end),
      analytics.topProductsByViews(start, end),
      analytics.topProductsByOrders(start, end),
      analytics.topOffersByViews(start, end),
      analytics.topOffersByOrders(start, end),
      analytics.topRatedProducts(10),
      analytics.topRatedOffers(10),
      topCompetitions(start, end),
    ]);

    const usageRegions = usageData.regions || [];
    const mostActiveRegions = usageRegions.filter((r) => r.usageCount > 0).slice(0, 10);
    const leastActiveRegions = [...usageRegions]
      .sort((a, b) => a.usageCount - b.usageCount)
      .slice(0, 10);

    const mostOrderRegions = ordersRegions.slice(0, 10);
    const leastOrderRegions = [...ordersRegions].sort((a, b) => a.orders - b.orders).slice(0, 10);
    const mostPrizeRegions = prizeRegions.slice(0, 10);
    const leastPrizeRegions = [...prizeRegions].sort((a, b) => a.prizes - b.prizes).slice(0, 10);

    res.status(200).json({
      period,
      range: { start, end },
      growthRate: {
        users: {
          current: newUsers,
          previous: prevNewUsers,
          ratePercent: growthRate(newUsers, prevNewUsers),
        },
        stores: {
          current: newStores,
          previous: prevNewStores,
          ratePercent: growthRate(newStores, prevNewStores),
        },
        offers: {
          current: newOffers,
          previous: prevNewOffers,
          ratePercent: growthRate(newOffers, prevNewOffers),
        },
        activity: {
          current: activityCurrent,
          previous: activityPrevious,
          ratePercent: growthRate(activityCurrent, activityPrevious),
        },
      },
      newUsers,
      dailyActivity,
      monthlyActivity,
      regions: {
        mostActive: mostActiveRegions,
        leastActive: leastActiveRegions,
        mostOrders: mostOrderRegions,
        leastOrders: leastOrderRegions,
      },
      prizesByRegion: {
        most: mostPrizeRegions,
        least: leastPrizeRegions,
        all: prizeRegions,
      },
      topStoresByVisits: topStoresVisits,
      topStoresByOrders: topStoresOrders,
      topStoresByPromoCodes: topStoresPromo,
      topProductsByViews: topProductsViews,
      topProductsByOrders: topProductsOrders,
      topOffersByViews: topOffersViews,
      topOffersByOrders: topOffersOrders,
      topRatedProducts,
      topRatedOffers,
      topCompetitions: topCompetitionsList,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب التحليلات", error: error.message });
  }
};
