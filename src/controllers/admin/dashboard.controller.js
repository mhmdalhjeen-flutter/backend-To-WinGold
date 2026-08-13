const User = require("../../models/user");
const Store = require("../../models/store");
const Product = require("../../models/product");
const Offer = require("../../models/offer");
const Competition = require("../../models/competition");
const PromoCode = require("../../models/promoCode");
const ActivationCode = require("../../models/ActivationCode");
const DailyPrize = require("../../models/dailyPrize");
const ActivityLog = require("../../models/ActivityLog");
const adminDashboard = require("../../services/adminDashboard.service");

const DEFAULT_DAYS = 30;

const dayKey = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};

const buildDayRange = (days) => {
  const keys = [];
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
};

const formatChartLabel = (isoDate) => {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
};

async function cumulativeGrowth(Model, match, days) {
  const keys = buildDayRange(days);
  const start = new Date(keys[0]);
  start.setHours(0, 0, 0, 0);

  const [baseTotal, dailyRows] = await Promise.all([
    Model.countDocuments({ ...match, createdAt: { $lt: start } }),
    Model.aggregate([
      { $match: { ...match, createdAt: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const map = Object.fromEntries(dailyRows.map((r) => [r._id, r.count]));
  let running = baseTotal;

  return keys.map((date) => {
    running += map[date] || 0;
    return {
      date,
      label: formatChartLabel(date),
      total: running,
      new: map[date] || 0,
    };
  });
}

async function getCards() {
  const [
    summary,
    suppliers,
    competitions,
    dailyPrizes,
    promoCodes,
    activationCodes,
    pointsAgg,
    referrals,
    activeStores,
    pendingStores,
  ] = await Promise.all([
    adminDashboard.getSummaryCards(),
    User.countDocuments({ role: "supplier" }),
    Competition.countDocuments(),
    DailyPrize.countDocuments(),
    PromoCode.countDocuments(),
    ActivationCode.countDocuments(),
    User.aggregate([
      { $match: { role: "customer" } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$points", 0] } } } },
    ]),
    User.countDocuments({ referralRewardGranted: true, referredBy: { $ne: null } }),
    Store.countDocuments({ isActive: true }),
    Store.countDocuments({ isActive: false }),
  ]);

  return {
    users: summary.users,
    stores: summary.stores,
    deliveryCompanies: summary.deliveryCompanies,
    products: summary.products,
    offers: summary.offers,
    productsAndOffers: summary.productsAndOffers,
    orders: summary.orders,
    suppliers,
    competitions,
    prizes: dailyPrizes,
    wheelPrizes: 0,
    dailyPrizes,
    codes: promoCodes + activationCodes,
    promoCodes,
    activationCodes,
    pointsDistributed: pointsAgg[0]?.total ?? 0,
    referrals,
    activeStores,
    pendingStores,
  };
}

async function getGrowth(days) {
  const [users, stores, offers] = await Promise.all([
    cumulativeGrowth(User, { role: "customer" }, days),
    cumulativeGrowth(Store, {}, days),
    cumulativeGrowth(Offer, {}, days),
  ]);

  return { users, stores, offers, days };
}

exports.getDashboardSummary = async (_req, res) => {
  try {
    const cards = await adminDashboard.getSummaryCards();
    res.status(200).json({
      cards,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب ملخص لوحة التحكم", error: error.message });
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || DEFAULT_DAYS, 7), 90);

    const [cards, growth, recentActivity, securityAlerts] = await Promise.all([
      getCards(),
      getGrowth(days),
      ActivityLog.find()
        .populate("user", "name role")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      ActivityLog.find({
        severity: { $in: ["warning", "danger"] },
        createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

    res.status(200).json({
      cards,
      growth,
      recentActivity,
      security: {
        count: securityAlerts.length,
        alerts: securityAlerts,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب لوحة التحكم", error: error.message });
  }
};

exports.getUsersByRegion = async (_req, res) => {
  try {
    const data = await adminDashboard.getUsersByMainRegion();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب توزيع المستخدمين", error: error.message });
  }
};

exports.getStoresByRegion = async (_req, res) => {
  try {
    const data = await adminDashboard.getStoresByRegionHierarchy();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب توزيع المتاجر", error: error.message });
  }
};

exports.getOrdersDaily = async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 90;
    const data = await adminDashboard.getOrderDailyTimeline(days);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب إحصائيات الطلبات", error: error.message });
  }
};

/** @deprecated استخدم GET /admin/dashboard */
exports.getStats = async (req, res) => {
  try {
    const cards = await getCards();
    res.status(200).json({
      totalUsers: cards.users,
      activeStores: cards.activeStores,
      pendingStores: cards.pendingStores,
      totalCodesUsed: cards.promoCodes,
      activeDraws: cards.competitions,
      totalCardsProduced: cards.wheelPrizes,
      activeBoxes: cards.dailyPrizes,
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب الإحصائيات", error: error.message });
  }
};
