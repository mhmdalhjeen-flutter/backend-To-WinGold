const User = require("../models/user");
const Store = require("../models/store");
const Product = require("../models/product");
const Offer = require("../models/offer");
const Order = require("../models/order");
const DeliveryCompany = require("../models/deliveryCompany");
const Region = require("../models/region");

const LOCATION_NOT_SPECIFIED = "Location not specified";

const DELIVERED_STATUSES = ["delivered_to_customer", "delivered", "completed_off_platform"];

const AR_MONTH_NAMES = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const AR_WEEKDAY_NAMES = [
  "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت",
];

function buildRootRegionResolver(regions) {
  const byId = Object.fromEntries(regions.map((r) => [String(r._id), r]));
  const cache = {};

  const getRoot = (regionId) => {
    if (!regionId) return null;
    const key = String(regionId);
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

    let current = byId[key];
    if (!current) {
      cache[key] = null;
      return null;
    }

    while (current.parent) {
      const parent = byId[String(current.parent)];
      if (!parent) break;
      current = parent;
    }

    cache[key] = current;
    return current;
  };

  return { byId, getRoot };
}

function groupUsersByMainRegion(rows, regions) {
  const { getRoot } = buildRootRegionResolver(regions);
  const counts = new Map();

  rows.forEach((row) => {
    const root = getRoot(row._id);
    const label = root?.name || LOCATION_NOT_SPECIFIED;
    counts.set(label, (counts.get(label) || 0) + row.count);
  });

  return Array.from(counts.entries())
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => {
      if (a.region === LOCATION_NOT_SPECIFIED) return 1;
      if (b.region === LOCATION_NOT_SPECIFIED) return -1;
      return b.count - a.count || a.region.localeCompare(b.region, "ar");
    });
}

function formatDisplayDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function formatMonthLabel(isoMonth) {
  const [year, month] = isoMonth.split("-");
  const monthIndex = parseInt(month, 10) - 1;
  return `${AR_MONTH_NAMES[monthIndex] || month} ${year}`;
}

function getWeekdayName(isoDate) {
  const date = new Date(`${isoDate}T12:00:00`);
  return AR_WEEKDAY_NAMES[date.getDay()];
}

function buildOrderTimelineWithMonths(dailyRows, days) {
  const map = Object.fromEntries(dailyRows.map((r) => [r._id, r.count]));
  const end = new Date();
  end.setHours(0, 0, 0, 0);

  const dayKeys = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const monthlyTotals = {};
  dayKeys.forEach((date) => {
    const monthKey = date.slice(0, 7);
    monthlyTotals[monthKey] = (monthlyTotals[monthKey] || 0) + (map[date] || 0);
  });

  const items = [];
  let lastMonth = null;

  dayKeys.forEach((date) => {
    const monthKey = date.slice(0, 7);

    items.push({
      type: "day",
      date,
      label: formatDisplayDate(date),
      weekday: getWeekdayName(date),
      delivered: map[date] || 0,
    });

    const nextIndex = dayKeys.indexOf(date) + 1;
    const nextMonth = nextIndex < dayKeys.length ? dayKeys[nextIndex].slice(0, 7) : null;
    const isLastDayOfMonthInRange = monthKey !== nextMonth;

    if (isLastDayOfMonthInRange && lastMonth !== monthKey) {
      items.push({
        type: "monthSummary",
        month: monthKey,
        label: formatMonthLabel(monthKey),
        totalDelivered: monthlyTotals[monthKey] || 0,
      });
      lastMonth = monthKey;
    }
  });

  return items;
}

async function getSummaryCards() {
  const [
    users,
    stores,
    deliveryCompanies,
    products,
    offers,
    orders,
  ] = await Promise.all([
    User.countDocuments({ role: "customer" }),
    Store.countDocuments(),
    DeliveryCompany.countDocuments({ deletedAt: null }),
    Product.countDocuments(),
    Offer.countDocuments(),
    Order.countDocuments(),
  ]);

  return {
    users,
    stores,
    deliveryCompanies,
    products,
    offers,
    productsAndOffers: products + offers,
    orders,
  };
}

async function getUsersByMainRegion() {
  const [regions, usersWithRegion, usersWithoutRegion] = await Promise.all([
    Region.find({ isActive: { $ne: false } }).select("name parent").lean(),
    User.aggregate([
      { $match: { role: "customer", "preferences.regionId": { $ne: null } } },
      { $group: { _id: "$preferences.regionId", count: { $sum: 1 } } },
    ]),
    User.countDocuments({
      role: "customer",
      $or: [{ "preferences.regionId": null }, { "preferences.regionId": { $exists: false } }],
    }),
  ]);

  const groups = groupUsersByMainRegion(usersWithRegion, regions);

  if (usersWithoutRegion > 0) {
    const existing = groups.find((g) => g.region === LOCATION_NOT_SPECIFIED);
    if (existing) {
      existing.count += usersWithoutRegion;
    } else {
      groups.push({ region: LOCATION_NOT_SPECIFIED, count: usersWithoutRegion });
    }
  }

  const total = groups.reduce((sum, g) => sum + g.count, 0);

  return { total, groups };
}

async function getStoresByRegionHierarchy() {
  const rows = await Store.aggregate([
    {
      $group: {
        _id: {
          mainId: "$regionId",
          subId: "$subRegionId",
        },
        count: { $sum: 1 },
        mainName: { $first: "$region" },
        subName: { $first: "$subRegion" },
      },
    },
    { $sort: { mainName: 1, subName: 1 } },
  ]);

  const mainMap = new Map();

  rows.forEach((row) => {
    const mainKey = row._id.mainId ? String(row._id.mainId) : row.mainName || "unknown";
    const subLabel = row.subName || "—";

    if (!mainMap.has(mainKey)) {
      mainMap.set(mainKey, {
        region: row.mainName || "—",
        regionId: row._id.mainId || null,
        total: 0,
        subRegions: [],
      });
    }

    const entry = mainMap.get(mainKey);
    entry.total += row.count;
    entry.subRegions.push({ name: subLabel, count: row.count });
  });

  const regions = Array.from(mainMap.values())
    .map((entry) => ({
      ...entry,
      subRegions: entry.subRegions.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ar")),
    }))
    .sort((a, b) => b.total - a.total || a.region.localeCompare(b.region, "ar"));

  const total = regions.reduce((sum, r) => sum + r.total, 0);

  return { total, regions };
}

async function getOrderDailyTimeline(days = 90) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(end.getDate() - (safeDays - 1));
  start.setHours(0, 0, 0, 0);

  const dailyRows = await Order.aggregate([
    {
      $match: {
        status: { $in: DELIVERED_STATUSES },
        $or: [
          { completedAt: { $gte: start, $lte: end } },
          {
            completedAt: null,
            updatedAt: { $gte: start, $lte: end },
          },
        ],
      },
    },
    {
      $project: {
        deliveredDay: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: { $ifNull: ["$completedAt", "$updatedAt"] },
          },
        },
      },
    },
    {
      $group: {
        _id: "$deliveredDay",
        count: { $sum: 1 },
      },
    },
  ]);

  const items = buildOrderTimelineWithMonths(dailyRows, safeDays);
  const totalDelivered = dailyRows.reduce((sum, row) => sum + row.count, 0);

  return { days: safeDays, totalDelivered, items };
}

module.exports = {
  LOCATION_NOT_SPECIFIED,
  DELIVERED_STATUSES,
  buildRootRegionResolver,
  groupUsersByMainRegion,
  buildOrderTimelineWithMonths,
  getSummaryCards,
  getUsersByMainRegion,
  getStoresByRegionHierarchy,
  getOrderDailyTimeline,
};
