const User = require("../../models/user");
const Store = require("../../models/store");
const Region = require("../../models/region");
const analytics = require("../../services/adminAnalytics.service");
const {
  normalizePeriod,
  getPeriodBounds,
  REGION_GEO,
  REGION_LABELS,
} = require("../../utils/analyticsPeriod.util");

const VALID_DIMENSIONS = ["all", "products", "offers", "stores", "orders", "prizes"];

function normalizeDimension(value) {
  return VALID_DIMENSIONS.includes(value) ? value : "all";
}

function intensityScore(value, max) {
  if (!max) return 0;
  return Math.round((value / max) * 100);
}

exports.getHeatMaps = async (req, res) => {
  try {
    const period = normalizePeriod(req.query.period);
    const dimension = normalizeDimension(req.query.dimension);
    const { start, end } = getPeriodBounds(period);

    const [activityByRegion, ordersRegions, prizeRegions, dbRegions, storeByRegion, usersByRegionPref] =
      await Promise.all([
        analytics.regionMetricCounts(start, end, dimension),
        analytics.ordersByRegion(start, end),
        analytics.prizeWinsByRegion(start, end),
        Region.find().select("name parent _id centerLat centerLng").lean(),
        Store.aggregate([
          {
            $group: {
              _id: "$region",
              storesCount: { $sum: 1 },
              visitsTotal: { $sum: { $ifNull: ["$totalVisits", 0] } },
            },
          },
        ]),
        User.aggregate([
          { $match: { role: "customer", "preferences.regionId": { $ne: null } } },
          { $group: { _id: "$preferences.regionId", usersCount: { $sum: 1 } } },
        ]),
      ]);

    const ordersMap = Object.fromEntries(ordersRegions.map((r) => [r.key, r.orders]));
    const prizesMap = {};
    prizeRegions.forEach((p) => {
      const enumKey = Object.entries(REGION_LABELS).find(([, label]) => label === p.label)?.[0];
      if (enumKey) prizesMap[enumKey] = (prizesMap[enumKey] || 0) + p.prizes;
      prizesMap[p.label] = (prizesMap[p.label] || 0) + p.prizes;
    });

    const regionUserCounts = {};
    if (usersByRegionPref.length) {
      const docs = await Region.find({
        _id: { $in: usersByRegionPref.map((u) => u._id).filter(Boolean) },
      }).lean();
      const byId = Object.fromEntries(docs.map((d) => [String(d._id), d]));
      usersByRegionPref.forEach((u) => {
        const doc = byId[String(u._id)];
        if (doc) regionUserCounts[doc.name] = u.usersCount;
      });
    }

    const cells = {};

    Object.entries(REGION_GEO).forEach(([key, geo]) => {
      cells[key] = {
        key,
        name: geo.label,
        usersCount: 0,
        storesCount: 0,
        activityCount: activityByRegion[key] || 0,
        ordersCount: ordersMap[key] || 0,
        prizesCount: prizesMap[key] || 0,
        visitsTotal: 0,
        coordinates: { lat: geo.lat, lng: geo.lng },
        source: "regionEnum",
      };
    });

    storeByRegion.forEach((row) => {
      const key = row._id;
      if (!key) return;
      if (!cells[key]) {
        cells[key] = {
          key,
          name: REGION_LABELS[key] || key,
          usersCount: 0,
          storesCount: 0,
          activityCount: 0,
          ordersCount: ordersMap[key] || 0,
          prizesCount: prizesMap[key] || 0,
          visitsTotal: 0,
          coordinates: REGION_GEO[key]
            ? { lat: REGION_GEO[key].lat, lng: REGION_GEO[key].lng }
            : null,
          source: "storeRegion",
        };
      }
      cells[key].storesCount = row.storesCount;
      cells[key].visitsTotal = row.visitsTotal;
    });

    dbRegions.forEach((r) => {
      const key = String(r._id);
      const coords =
        r.centerLat != null && r.centerLng != null
          ? { lat: r.centerLat, lng: r.centerLng }
          : null;
      cells[key] = {
        key,
        name: r.name,
        usersCount: regionUserCounts[r.name] || 0,
        storesCount: cells[key]?.storesCount || 0,
        activityCount: activityByRegion[r.name] || activityByRegion[key] || cells[key]?.activityCount || 0,
        ordersCount: ordersMap[r.name] || ordersMap[key] || 0,
        prizesCount: prizesMap[r.name] || prizesMap[key] || 0,
        visitsTotal: cells[key]?.visitsTotal || 0,
        coordinates: coords || cells[key]?.coordinates || null,
        source: "regionDocument",
      };
    });

    Object.entries(regionUserCounts).forEach(([name, count]) => {
      const cell = Object.values(cells).find((c) => c.name === name);
      if (cell) cell.usersCount = count;
    });

    const list = Object.values(cells);
    const metricForLayer = (cell, layer) => {
      if (layer === "orders") return cell.ordersCount;
      if (layer === "prizes") return cell.prizesCount;
      if (layer === "users") return cell.usersCount;
      if (layer === "stores") return cell.storesCount;
      if (layer === "activity") return cell.activityCount;
      return cell.activityCount * 2 + cell.ordersCount * 3 + cell.prizesCount * 2 + cell.usersCount + cell.storesCount;
    };

    const maxActivity = Math.max(...list.map((c) => c.activityCount), 1);
    const maxUsers = Math.max(...list.map((c) => c.usersCount), 1);
    const maxStores = Math.max(...list.map((c) => c.storesCount), 1);
    const maxOrders = Math.max(...list.map((c) => c.ordersCount), 1);
    const maxPrizes = Math.max(...list.map((c) => c.prizesCount), 1);
    const maxCombined = Math.max(...list.map((c) => metricForLayer(c, "combined")), 1);

    const regions = list
      .map((cell) => ({
        ...cell,
        intensity: {
          activity: intensityScore(cell.activityCount, maxActivity),
          users: intensityScore(cell.usersCount, maxUsers),
          stores: intensityScore(cell.storesCount, maxStores),
          orders: intensityScore(cell.ordersCount, maxOrders),
          prizes: intensityScore(cell.prizesCount, maxPrizes),
          combined: intensityScore(metricForLayer(cell, "combined"), maxCombined),
        },
      }))
      .sort((a, b) => b.intensity.combined - a.intensity.combined);

    const mapPoints = regions
      .filter((r) => r.coordinates?.lat != null && r.coordinates?.lng != null)
      .map((r) => ({
        name: r.name,
        lat: r.coordinates.lat,
        lng: r.coordinates.lng,
        intensity: r.intensity.combined,
        activityCount: r.activityCount,
        ordersCount: r.ordersCount,
        prizesCount: r.prizesCount,
        usersCount: r.usersCount,
        storesCount: r.storesCount,
      }));

    res.status(200).json({
      period,
      dimension,
      range: { start, end },
      mode: mapPoints.length ? "hybrid" : "regions",
      mapReady: mapPoints.length > 0,
      regions,
      mapPoints,
      ordersByRegion: ordersRegions,
      prizesByRegion: prizeRegions,
      totals: {
        users: list.reduce((s, r) => s + r.usersCount, 0),
        stores: list.reduce((s, r) => s + r.storesCount, 0),
        activity: list.reduce((s, r) => s + r.activityCount, 0),
        orders: list.reduce((s, r) => s + r.ordersCount, 0),
        prizes: list.reduce((s, r) => s + r.prizesCount, 0),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب خريطة الحرارة", error: error.message });
  }
};
