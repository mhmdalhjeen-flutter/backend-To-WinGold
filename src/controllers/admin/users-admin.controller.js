const mongoose = require("mongoose");
const User = require("../../models/user");
const Region = require("../../models/region");
const Store = require("../../models/store");
const StoreMembership = require("../../models/storeMembership");
const BazaarListing = require("../../models/bazaarListing");
const UserActivity = require("../../models/userActivity");
const Competition = require("../../models/competition");
const DrawBatch = require("../../models/drawBatch");
const WheelWin = require("../../models/wheelWin");
const HonorBoard = require("../../models/honorBoard");
const { buildUserPrizeStatsMap } = require("../../services/adminAnalytics.service");
const { cleanString, numberInRange, requireObjectId, safeRegex } = require("../../utils/inputSecurity.util");
const { USER_SENSITIVE_SELECT, sanitizeUser } = require("../../utils/userSanitize.util");

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  highest_points: { points: -1, createdAt: -1 },
  most_active: "activityCount",
  least_active: "activityCount",
};

function parseBoolFilter(value) {
  if (value === "yes" || value === "true" || value === "1") return true;
  if (value === "no" || value === "false" || value === "0") return false;
  return null;
}

function activityLevelFromCount(count) {
  if (!count) return "none";
  if (count <= 10) return "low";
  if (count <= 50) return "medium";
  return "high";
}

async function buildActivityMap() {
  const rows = await UserActivity.aggregate([
    { $group: { _id: "$user", count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
}

async function buildParticipationMap() {
  const [compRows, drawRows] = await Promise.all([
    Competition.aggregate([
      { $unwind: "$participants" },
      {
        $group: {
          _id: "$participants.user",
          total: { $sum: { $ifNull: ["$participants.entriesCount", 1] } },
        },
      },
    ]),
    DrawBatch.aggregate([
      { $unwind: "$participants" },
      {
        $group: {
          _id: "$participants.user",
          total: { $sum: { $ifNull: ["$participants.entriesCount", 1] } },
        },
      },
    ]),
  ]);

  const map = {};
  [...compRows, ...drawRows].forEach((row) => {
    if (!row._id) return;
    const id = String(row._id);
    map[id] = (map[id] || 0) + (row.total || 0);
  });
  return map;
}

async function buildPrizeWinnerSet() {
  const [drawUsers, wheelUsers, honorUsers] = await Promise.all([
    DrawBatch.distinct("winners.user"),
    WheelWin.distinct("user"),
    HonorBoard.distinct("user"),
  ]);
  return new Set(
    [...drawUsers, ...wheelUsers, ...honorUsers].filter(Boolean).map(String)
  );
}

async function buildStoreMemberSet(storeId) {
  const filter = { status: "member" };
  if (storeId) {
    filter.store = requireObjectId(storeId, "storeId");
  }
  const ids = await StoreMembership.distinct("user", filter);
  return new Set(ids.filter(Boolean).map(String));
}

async function buildMarketplaceSet() {
  const ids = await BazaarListing.distinct("seller");
  return new Set(ids.filter(Boolean).map(String));
}

function buildUserMatch(query) {
  const match = { role: "customer" };

  const qText = cleanString(query.q, { field: "q", max: 80 });
  if (qText) {
    const q = safeRegex(qText, { field: "q", max: 80 });
    match.$or = [
      { name: q },
      { email: q },
      { phone: q },
    ];
  }

  if (query.regionId) {
    match["preferences.regionId"] = requireObjectId(query.regionId, "regionId");
  }

  const points = {};
  if (query.pointsMin != null && query.pointsMin !== "") {
    points.$gte = numberInRange(query.pointsMin, { field: "pointsMin", min: 0, max: 1_000_000 });
  }
  if (query.pointsMax != null && query.pointsMax !== "") {
    points.$lte = numberInRange(query.pointsMax, { field: "pointsMax", min: 0, max: 1_000_000 });
  }
  if (Object.keys(points).length) match.points = points;

  if (query.registeredFrom || query.registeredTo) {
    match.createdAt = {};
    if (query.registeredFrom) {
      const start = new Date(cleanString(query.registeredFrom, { field: "registeredFrom", max: 40 }));
      if (Number.isNaN(start.getTime())) throw Object.assign(new Error("registeredFrom غير صالح"), { status: 400 });
      match.createdAt.$gte = start;
    }
    if (query.registeredTo) {
      const end = new Date(cleanString(query.registeredTo, { field: "registeredTo", max: 40 }));
      if (Number.isNaN(end.getTime())) throw Object.assign(new Error("registeredTo غير صالح"), { status: 400 });
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  return match;
}

function enrichUser(user, ctx) {
  const id = String(user._id);
  const activityCount = ctx.activityMap[id] || 0;
  const participationsCount = ctx.participationMap[id] || 0;
  const prizeStats = ctx.prizeStatsMap?.[id] || {};

  return {
    ...user,
    activityCount,
    participationsCount,
    activityLevel: activityLevelFromCount(activityCount),
    regionName: user.preferences?.regionId?.name || null,
    hasWonPrize: ctx.prizeWinners ? ctx.prizeWinners.has(id) : false,
    hasStoreMembership: ctx.storeMembers ? ctx.storeMembers.has(id) : false,
    usesMarketplace: ctx.marketplaceUsers ? ctx.marketplaceUsers.has(id) : false,
    hasPhysicalWheelPrize: prizeStats.hasPhysicalWheelPrize || false,
    physicalWheelPrizes: prizeStats.physicalWheelPrizes || 0,
    competitionsJoined: prizeStats.competitionsJoined || participationsCount,
    hasCompetitionHistory: prizeStats.hasCompetitionHistory || participationsCount > 0,
    totalPrizesCount: prizeStats.totalPrizesCount || 0,
  };
}

function sortUsers(users, sortKey) {
  if (sortKey === "most_active") {
    users.sort(
      (a, b) =>
        b.activityCount - a.activityCount ||
        new Date(b.createdAt) - new Date(a.createdAt)
    );
    return;
  }
  if (sortKey === "least_active") {
    users.sort(
      (a, b) =>
        a.activityCount - b.activityCount ||
        new Date(b.createdAt) - new Date(a.createdAt)
    );
    return;
  }
  if (sortKey === "highest_points") {
    users.sort(
      (a, b) =>
        (b.points || 0) - (a.points || 0) ||
        new Date(b.createdAt) - new Date(a.createdAt)
    );
    return;
  }
  users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function passesFilters(user, query, ctx) {
  const id = String(user._id);

  if (ctx.prizeWinners) {
    const won = ctx.prizeWinners.has(id);
    if (query.wonPrize === "yes" && !won) return false;
    if (query.wonPrize === "no" && won) return false;
  }

  if (ctx.storeMembers) {
    const member = ctx.storeMembers.has(id);
    if (query.joinedStore === "yes" && !member) return false;
    if (query.joinedStore === "no" && member) return false;
    if (query.storeId && !member) return false;
  }

  if (ctx.marketplaceUsers) {
    const uses = ctx.marketplaceUsers.has(id);
    if (query.usesMarketplace === "yes" && !uses) return false;
    if (query.usesMarketplace === "no" && !uses) return false;
  }

  if (query.activityLevel) {
    const safeLevel = cleanString(query.activityLevel, { field: "activityLevel", max: 20 });
    if (!["none", "low", "medium", "high"].includes(safeLevel)) return false;
    const level = activityLevelFromCount(ctx.activityMap[id] || 0);
    if (level !== safeLevel) return false;
  }

  const participations = ctx.participationMap[id] || 0;
  if (query.participationsMin != null && query.participationsMin !== "") {
    if (participations < numberInRange(query.participationsMin, { field: "participationsMin", min: 0, max: 1_000_000 })) return false;
  }
  if (query.participationsMax != null && query.participationsMax !== "") {
    if (participations > numberInRange(query.participationsMax, { field: "participationsMax", min: 0, max: 1_000_000 })) return false;
  }

  return true;
}

exports.getFilterOptions = async (_req, res) => {
  try {
    const [regions, stores] = await Promise.all([
      Region.find({ isActive: { $ne: false } }).select("name _id parent").sort({ sortOrder: 1, name: 1 }).lean(),
      Store.find({ isActive: true }).select("name _id region").sort({ name: 1 }).lean(),
    ]);

    res.json({
      regions,
      stores,
      sortOptions: [
        { value: "newest", label: "أحدث المستخدمين" },
        { value: "most_active", label: "الأكثر نشاطاً" },
        { value: "least_active", label: "الأقل نشاطاً" },
        { value: "highest_points", label: "الأعلى نقاطاً" },
      ],
      activityLevels: [
        { value: "none", label: "بدون نشاط" },
        { value: "low", label: "نشاط منخفض (1–10)" },
        { value: "medium", label: "نشاط متوسط (11–50)" },
        { value: "high", label: "نشاط مرتفع (+51)" },
      ],
    });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب خيارات الفلترة", error: error.message });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const sortParam = cleanString(req.query.sort, { field: "sort", max: 40 });
    const sort = SORT_OPTIONS[sortParam] ? sortParam : "newest";
    if (req.query.storeId) requireObjectId(req.query.storeId, "storeId");

    const needsActivity =
      sort === "most_active" ||
      sort === "least_active" ||
      Boolean(req.query.activityLevel);
    const needsParticipations =
      req.query.participationsMin != null ||
      req.query.participationsMax != null;

    const needsPrizeFilter = parseBoolFilter(req.query.wonPrize) !== null;
    const needsStoreFilter =
      parseBoolFilter(req.query.joinedStore) !== null || Boolean(req.query.storeId);
    const needsMarketplaceFilter = parseBoolFilter(req.query.usesMarketplace) !== null;

    const wonPrize = parseBoolFilter(req.query.wonPrize);
    const joinedStore = parseBoolFilter(req.query.joinedStore);
    const usesMarketplace = parseBoolFilter(req.query.usesMarketplace);

    const filterQuery = {
      ...req.query,
      wonPrize: wonPrize === true ? "yes" : wonPrize === false ? "no" : undefined,
      joinedStore: joinedStore === true ? "yes" : joinedStore === false ? "no" : undefined,
      usesMarketplace:
        usesMarketplace === true ? "yes" : usesMarketplace === false ? "no" : undefined,
    };

    const [activityMap, participationMap, prizeWinners, storeMembers, marketplaceUsers] =
      await Promise.all([
        needsActivity ? buildActivityMap() : {},
        needsParticipations ? buildParticipationMap() : {},
        needsPrizeFilter ? buildPrizeWinnerSet() : null,
        needsStoreFilter ? buildStoreMemberSet(req.query.storeId) : null,
        needsMarketplaceFilter ? buildMarketplaceSet() : null,
      ]);

    const ctx = {
      activityMap,
      participationMap,
      prizeWinners,
      storeMembers,
      marketplaceUsers,
    };

    let users = await User.find(buildUserMatch(req.query))
      .select(USER_SENSITIVE_SELECT)
      .populate("preferences.regionId", "name")
      .lean();

    users = users.filter((u) => passesFilters(u, filterQuery, ctx));
    users = users.map((u) => enrichUser(u, ctx));
    sortUsers(users, sort);

    const total = users.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);
    const paged = users.slice((safePage - 1) * limit, safePage * limit);

    const pageIds = paged.map((u) => u._id);
    const prizeStatsMap = pageIds.length ? await buildUserPrizeStatsMap(pageIds) : {};

    if (!needsActivity || !needsParticipations) {
      const [pageActivity, pageParticipations] = await Promise.all([
        !needsActivity && pageIds.length
          ? UserActivity.aggregate([
              { $match: { user: { $in: pageIds } } },
              { $group: { _id: "$user", count: { $sum: 1 } } },
            ])
          : [],
        !needsParticipations && pageIds.length
          ? (async () => {
              const map = {};
              const [compRows, drawRows] = await Promise.all([
                Competition.aggregate([
                  { $unwind: "$participants" },
                  { $match: { "participants.user": { $in: pageIds } } },
                  {
                    $group: {
                      _id: "$participants.user",
                      total: { $sum: { $ifNull: ["$participants.entriesCount", 1] } },
                    },
                  },
                ]),
                DrawBatch.aggregate([
                  { $unwind: "$participants" },
                  { $match: { "participants.user": { $in: pageIds } } },
                  {
                    $group: {
                      _id: "$participants.user",
                      total: { $sum: { $ifNull: ["$participants.entriesCount", 1] } },
                    },
                  },
                ]),
              ]);
              [...compRows, ...drawRows].forEach((row) => {
                if (!row._id) return;
                const id = String(row._id);
                map[id] = (map[id] || 0) + (row.total || 0);
              });
              return map;
            })()
          : {},
      ]);

      if (!needsActivity) {
        const actMap = Object.fromEntries(
          pageActivity.map((r) => [String(r._id), r.count])
        );
        paged.forEach((u) => {
          u.activityCount = actMap[String(u._id)] || 0;
          u.activityLevel = activityLevelFromCount(u.activityCount);
        });
      }

      if (!needsParticipations) {
        paged.forEach((u) => {
          u.participationsCount = pageParticipations[String(u._id)] || 0;
        });
      }
    }

    if (!needsPrizeFilter) {
      const pageIds = paged.map((u) => u._id);
      if (pageIds.length) {
        const winners = await buildPrizeWinnerSet();
        paged.forEach((u) => {
          u.hasWonPrize = winners.has(String(u._id));
        });
      }
    }

    if (!needsStoreFilter) {
      const pageIds = paged.map((u) => u._id);
      if (pageIds.length) {
        const memberships = await StoreMembership.find({
          user: { $in: pageIds },
          status: "member",
        })
          .select("user store")
          .populate("store", "name")
          .lean();
        const byUser = {};
        memberships.forEach((m) => {
          const id = String(m.user);
          if (!byUser[id]) byUser[id] = [];
          byUser[id].push({ _id: m.store?._id, name: m.store?.name });
        });
        paged.forEach((u) => {
          u.storeMemberships = byUser[String(u._id)] || [];
          u.hasStoreMembership = u.storeMemberships.length > 0;
        });
      }
    } else {
      paged.forEach((u) => {
        u.hasStoreMembership = ctx.storeMembers.has(String(u._id));
      });
    }

    if (!needsMarketplaceFilter && paged.length) {
      const counts = await BazaarListing.aggregate([
        { $match: { seller: { $in: paged.map((u) => u._id) } } },
        { $group: { _id: "$seller", count: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(
        counts.map((r) => [String(r._id), r.count])
      );
      paged.forEach((u) => {
        u.bazaarListingsCount = countMap[String(u._id)] || 0;
        u.usesMarketplace = u.bazaarListingsCount > 0;
      });
    }

    paged.forEach((u) => {
      const stats = prizeStatsMap[String(u._id)] || {};
      u.hasPhysicalWheelPrize = stats.hasPhysicalWheelPrize || false;
      u.physicalWheelPrizes = stats.physicalWheelPrizes || 0;
      u.competitionsJoined = stats.competitionsJoined ?? u.participationsCount ?? 0;
      u.hasCompetitionHistory = stats.hasCompetitionHistory || u.competitionsJoined > 0;
      u.totalPrizesCount = stats.totalPrizesCount || 0;
    });

    res.json({
      users: paged,
      pagination: {
        page: safePage,
        limit,
        total,
        pages,
      },
      sort,
      filters: filterQuery,
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: "خطأ في جلب المستخدمين", error: error.message });
  }
};

exports.getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "معرّف غير صالح" });
    }

    const user = await User.findById(id)
      .select(USER_SENSITIVE_SELECT)
      .populate("preferences.regionId", "name parent")
      .lean();

    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const [
      activityCount,
      participationsMap,
      prizeWinners,
      memberships,
      bazaarCount,
      recentActivity,
      wheelWins,
      honorEntries,
      drawWins,
    ] = await Promise.all([
      UserActivity.countDocuments({ user: id }),
      buildParticipationMap(),
      buildPrizeWinnerSet(),
      StoreMembership.find({ user: id, status: "member" })
        .populate("store", "name region logo")
        .lean(),
      BazaarListing.countDocuments({ seller: id }),
      UserActivity.find({ user: id }).sort({ createdAt: -1 }).limit(15).lean(),
      WheelWin.find({ user: id }).sort({ wonAt: -1 }).limit(5).select("prizeName wonAt deliveryStatus").lean(),
      HonorBoard.find({ user: id }).sort({ createdAt: -1 }).limit(5).select("title prizeName receivedAt").lean(),
      DrawBatch.find({ "winners.user": id })
        .select("name winners eventDate")
        .sort({ "winners.wonAt": -1 })
        .limit(5)
        .lean(),
    ]);

    const drawPrizes = drawWins.flatMap((draw) =>
      (draw.winners || [])
        .filter((w) => String(w.user) === String(id))
        .map((w) => ({
          drawName: draw.name,
          prize: w.prize,
          wonAt: w.wonAt,
          eventDate: draw.eventDate,
        }))
    );

    const prizeStatsMap = await buildUserPrizeStatsMap([id]);
    const prizeStats = prizeStatsMap[String(id)] || {};

    res.json({
      user: {
        ...user,
        activityCount,
        participationsCount: participationsMap[String(id)] || 0,
        activityLevel: activityLevelFromCount(activityCount),
        regionName: user.preferences?.regionId?.name || null,
        hasWonPrize: prizeWinners.has(String(id)),
        bazaarListingsCount: bazaarCount,
        usesMarketplace: bazaarCount > 0,
        hasPhysicalWheelPrize: prizeStats.hasPhysicalWheelPrize || false,
        physicalWheelPrizes: prizeStats.physicalWheelPrizes || 0,
        competitionsJoined: prizeStats.competitionsJoined || participationsMap[String(id)] || 0,
        hasCompetitionHistory: prizeStats.hasCompetitionHistory || false,
        totalPrizesCount: prizeStats.totalPrizesCount || 0,
      },
      storeMemberships: memberships,
      recentActivity,
      prizes: {
        wheel: wheelWins,
        honor: honorEntries,
        draws: drawPrizes,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: "خطأ في جلب تفاصيل المستخدم", error: error.message });
  }
};
