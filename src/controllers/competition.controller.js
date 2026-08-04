const mongoose = require("mongoose");
const Competition = require("../models/competition");
const User = require("../models/user");
const ExcelJS = require("exceljs");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { assertNoMongoOperators, intInRange, requireObjectId } = require("../utils/inputSecurity.util");

const JOIN_COOLDOWN_MS = 2000;

async function processCompetitionImages(body) {
  const data = { ...body };
  if (data.image) data.image = await processOptionalImage(data.image);
  if (data.prizeImage) data.prizeImage = await processOptionalImage(data.prizeImage);
  return data;
}

const PUBLIC_FIELDS =
  "title description image minPoints pointsPerEntry requiredParticipants location startDate endDate isFeatured status totalEntries participants prizeName prizeImage drawLink createdAt";

function isCompetitionEnded(comp) {
  if (!comp) return false;
  if (comp.status === "ended") return true;
  if (comp.endDate && new Date(comp.endDate) <= new Date()) return true;
  return false;
}

function computeDisplayStatus(comp) {
  if (comp.status === "draft") return "draft";
  if (isCompetitionEnded(comp)) return "ended";
  return "active";
}

const toPublic = (comp, userId, { forList = false } = {}) => {
  const obj = comp.toObject ? comp.toObject() : comp;
  const participantsCount = obj.participants ? obj.participants.length : 0;
  let myEntries = 0;
  let joined = false;
  if (userId && obj.participants) {
    const mine = obj.participants.find(
      (p) => p.user && p.user.toString() === userId.toString()
    );
    if (mine) {
      joined = true;
      myEntries = mine.entriesCount;
    }
  }
  delete obj.participants;
  delete obj.drawNotificationSent;
  let result = {
    ...obj,
    participantsCount,
    joined,
    myEntries,
    hasEnded: isCompetitionEnded(obj),
    displayStatus: computeDisplayStatus(obj),
  };
  if (forList) {
    if (typeof result.image === "string" && result.image.startsWith("data:")) {
      result = { ...result, hasImage: true, image: null };
    } else {
      result = { ...result, hasImage: !!result.image };
    }
    if (typeof result.prizeImage === "string" && result.prizeImage.startsWith("data:")) {
      result = { ...result, hasPrizeImage: true, prizeImage: null };
    } else {
      result = { ...result, hasPrizeImage: !!result.prizeImage };
    }
  }
  return result;
};

const toAdminSummary = (comp) => {
  const obj = comp.toObject ? comp.toObject() : comp;
  const participantsCount = obj.participants ? obj.participants.length : 0;
  delete obj.participants;
  delete obj.drawNotificationSent;
  return {
    ...obj,
    participantsCount,
    totalParticipations: obj.totalEntries || 0,
    displayStatus: computeDisplayStatus(obj),
  };
};

/* ============== العميل / العام ============== */

const MAX_FEATURED_COMPETITIONS = 2;

exports.getFeatured = async (req, res) => {
  try {
    const comps = await Competition.find({
      isFeatured: true,
      status: { $in: ["active", "ended"] },
    })
      .select(PUBLIC_FIELDS + " participants")
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(MAX_FEATURED_COMPETITIONS)
      .lean();

    let userPoints = 0;
    if (req.user?.id) {
      const u = await User.findById(req.user.id).select("points");
      userPoints = u ? u.points : 0;
    }

    const competitions = comps.map((c) => toPublic(c, req.user?.id, { forList: true }));

    return res.json({
      competitions,
      competition: competitions[0] || null,
      userPoints,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const comps = await Competition.find({ status: "active" })
      .select(PUBLIC_FIELDS + " participants")
      .sort({ isFeatured: -1, createdAt: -1 })
      .lean();
    res.json(comps.map((c) => toPublic(c, req.user?.id, { forList: true })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findById(id);
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });
    res.json(toPublic(comp, req.user?.id));
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

function activeCompetitionFilter(compId) {
  const now = new Date();
  return {
    _id: compId,
    status: "active",
    $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gt: now } }],
  };
}

async function applyCompetitionJoin(compId, userId, entries, cost, session) {
  const uid = new mongoose.Types.ObjectId(userId);
  const now = new Date();
  const cutoff = new Date(Date.now() - JOIN_COOLDOWN_MS);
  const opts = { new: true };
  if (session) opts.session = session;

  let updated = await Competition.findOneAndUpdate(
    {
      ...activeCompetitionFilter(compId),
      "participants.user": { $ne: uid },
    },
    {
      $push: {
        participants: {
          user: uid,
          entriesCount: entries,
          pointsSpent: cost,
          joinedAt: now,
          lastJoinedAt: now,
        },
      },
      $inc: { totalEntries: entries },
    },
    opts
  );

  if (updated) return updated;

  updated = await Competition.findOneAndUpdate(
    {
      ...activeCompetitionFilter(compId),
      participants: {
        $elemMatch: {
          user: uid,
          lastJoinedAt: { $lte: cutoff },
        },
      },
    },
    {
      $inc: {
        "participants.$[elem].entriesCount": entries,
        "participants.$[elem].pointsSpent": cost,
        totalEntries: entries,
      },
      $set: { "participants.$[elem].lastJoinedAt": now },
    },
    {
      ...opts,
      arrayFilters: [{ "elem.user": uid }],
    }
  );

  return updated;
}

async function joinCompetitionWithSession(req, session) {
  assertNoMongoOperators(req.body, "join");
  const entries = intInRange(req.body.entries, { field: "entries", min: 1, max: 1000, required: true });
  if (!entries || entries < 1) {
    return { error: { status: 400, message: "عدد المشاركات يجب أن يكون 1 على الأقل" } };
  }

  const compId = requireObjectId(req.params.id, "id");
  const compPreview = await Competition.findById(compId);
  if (!compPreview) {
    return { error: { status: 404, message: "المسابقة غير موجودة" } };
  }

  if (compPreview.status !== "active") {
    return { error: { status: 400, message: "المسابقة غير متاحة للمشاركة حالياً" } };
  }
  if (isCompetitionEnded(compPreview)) {
    return { error: { status: 400, message: "انتهت هذه المسابقة" } };
  }

  const userPreview = await User.findById(req.user.id).select("points");
  if (!userPreview) {
    return { error: { status: 404, message: "المستخدم غير موجود" } };
  }

  if (userPreview.points < compPreview.minPoints) {
    return {
      error: {
        status: 403,
        message: "نقاطك غير كافية للتأهّل لهذه المسابقة",
        missingPoints: compPreview.minPoints - userPreview.points,
      },
    };
  }

  const cost = entries * compPreview.pointsPerEntry;
  if (userPreview.points < cost) {
    return {
      error: {
        status: 400,
        message: "نقاطك غير كافية لشراء هذا العدد من المشاركات",
        needed: cost,
        userPoints: userPreview.points,
      },
    };
  }

  const userOpts = { new: true };
  if (session) userOpts.session = session;

  const user = await User.findOneAndUpdate(
    { _id: req.user.id, points: { $gte: cost } },
    { $inc: { points: -cost } },
    userOpts
  );
  if (!user) {
    return {
      error: {
        status: 400,
        message: "نقاطك غير كافية لشراء هذا العدد من المشاركات",
        needed: cost,
        userPoints: userPreview.points,
      },
    };
  }

  const comp = await applyCompetitionJoin(compPreview._id, req.user.id, entries, cost, session);
  if (!comp) {
    if (!session) {
      await User.findByIdAndUpdate(req.user.id, { $inc: { points: cost } });
    }
    return {
      error: {
        status: 429,
        message: "تمت المشاركة للتو — انتظر قليلاً قبل المحاولة مرة أخرى",
      },
    };
  }

  return { comp, user };
}

exports.joinCompetition = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await joinCompetitionWithSession(req, session);
    if (result.error) {
      await session.abortTransaction();
      return res.status(result.error.status).json(result.error);
    }
    await session.commitTransaction();
    return res.json({
      message: "تمت المشاركة بنجاح",
      competition: toPublic(result.comp, result.user._id),
      userPoints: result.user.points,
    });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (
      err.message?.includes("Transaction numbers") ||
      err.code === 20 ||
      err.code === 251 ||
      err.code === 263
    ) {
      try {
        const result = await joinCompetitionWithSession(req, null);
        if (result.error) {
          return res.status(result.error.status).json(result.error);
        }
        return res.json({
          message: "تمت المشاركة بنجاح",
          competition: toPublic(result.comp, result.user._id),
          userPoints: result.user.points,
        });
      } catch (fallbackErr) {
        if (fallbackErr.name === "CastError") {
          return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
        }
        return res.status(fallbackErr.status || 500).json({ message: fallbackErr.message });
      }
    }
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    return res.status(err.status || 500).json({ message: err.message });
  } finally {
    session.endSession();
  }
};

/* ============== الأدمن ============== */

exports.getAllAdmin = async (req, res) => {
  try {
    const comps = await Competition.find().sort({ createdAt: -1 });
    res.json(comps.map((c) => toAdminSummary(c)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getParticipantsAdmin = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findById(id).populate(
      "participants.user",
      "name phone email"
    );
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });

    const participants = (comp.participants || []).map((p) => ({
      userId: p.user?._id,
      name: p.user?.name || "—",
      contact: p.user?.phone || p.user?.email || "—",
      entriesCount: p.entriesCount || 0,
      firstJoinedAt: p.joinedAt,
      lastJoinedAt: p.lastJoinedAt || p.joinedAt,
    }));

    res.json({
      competition: toAdminSummary(comp),
      participants,
      totalParticipations: comp.totalEntries || 0,
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.exportParticipantsExcel = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findById(id).populate(
      "participants.user",
      "name phone email"
    );
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("المشاركون");

    sheet.columns = [
      { header: "اسم المشارك", key: "name", width: 28 },
      { header: "الهاتف / البريد", key: "contact", width: 22 },
      { header: "عدد المشاركات", key: "entriesCount", width: 16 },
      { header: "تاريخ أول مشاركة", key: "firstJoinedAt", width: 22 },
      { header: "تاريخ آخر مشاركة", key: "lastJoinedAt", width: 22 },
    ];

    (comp.participants || []).forEach((p) => {
      sheet.addRow({
        name: p.user?.name || "—",
        contact: p.user?.phone || p.user?.email || "—",
        entriesCount: p.entriesCount || 0,
        firstJoinedAt: p.joinedAt ? new Date(p.joinedAt).toLocaleString("ar") : "—",
        lastJoinedAt: (p.lastJoinedAt || p.joinedAt)
          ? new Date(p.lastJoinedAt || p.joinedAt).toLocaleString("ar")
          : "—",
      });
    });

    sheet.getRow(1).font = { bold: true };

    const safeTitle = (comp.title || "competition").replace(/[^\w\u0600-\u06FF-]+/g, "_");
    const filename = `participants-${safeTitle}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.clearParticipants = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findById(id);
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });

    comp.participants = [];
    comp.totalEntries = 0;
    await comp.save();

    res.json({ message: "تم تفريغ المشاركين بنجاح", competition: toAdminSummary(comp) });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createCompetition = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "competition");
    const { participants, totalEntries, drawNotificationSent, ...body } = req.body;
    const data = await processCompetitionImages({ ...body, createdBy: req.user.id });
    const comp = await Competition.create(data);

    if (comp.isFeatured) {
      const featuredOthers = await Competition.find({
        isFeatured: true,
        _id: { $ne: comp._id },
      })
        .sort({ updatedAt: 1 })
        .select("_id");

      if (featuredOthers.length >= MAX_FEATURED_COMPETITIONS) {
        const excess = featuredOthers.slice(0, featuredOthers.length - MAX_FEATURED_COMPETITIONS + 1);
        await Competition.updateMany(
          { _id: { $in: excess.map((c) => c._id) } },
          { $set: { isFeatured: false } }
        );
      }
    }

    res.status(201).json(toAdminSummary(comp));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updateCompetition = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "competition");
    const { participants, totalEntries, drawNotificationSent, ...safe } = req.body;
    const processed = await processCompetitionImages(safe);

    const id = requireObjectId(req.params.id, "id");
    const existing = await Competition.findById(id);
    if (!existing) return res.status(404).json({ message: "المسابقة غير موجودة" });

    if (safe.endDate) {
      const newEnd = new Date(safe.endDate);
      if (newEnd > new Date()) {
        processed.drawNotificationSent = false;
        if (processed.status === undefined && existing.status === "ended") {
          processed.status = "active";
        }
      }
    }

    const comp = await Competition.findByIdAndUpdate(id, processed, {
      new: true,
      runValidators: true,
    });

    if (comp.isFeatured) {
      const featuredOthers = await Competition.find({
        isFeatured: true,
        _id: { $ne: comp._id },
      })
        .sort({ updatedAt: 1 })
        .select("_id");

      if (featuredOthers.length >= MAX_FEATURED_COMPETITIONS) {
        const excess = featuredOthers.slice(0, featuredOthers.length - MAX_FEATURED_COMPETITIONS + 1);
        await Competition.updateMany(
          { _id: { $in: excess.map((c) => c._id) } },
          { $set: { isFeatured: false } }
        );
      }
    }

    res.json(toAdminSummary(comp));
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.deleteCompetition = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findByIdAndDelete(id);
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });
    res.json({ message: "تم حذف المسابقة" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.setFeatured = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const comp = await Competition.findById(id);
    if (!comp) return res.status(404).json({ message: "المسابقة غير موجودة" });

    if (comp.isFeatured) {
      comp.isFeatured = false;
      await comp.save();
      return res.json(toAdminSummary(comp));
    }

    const featuredCount = await Competition.countDocuments({
      isFeatured: true,
      _id: { $ne: comp._id },
    });

    if (featuredCount >= MAX_FEATURED_COMPETITIONS) {
      return res.status(400).json({
        message: `يمكن تعيين ${MAX_FEATURED_COMPETITIONS} مسابقات مميزة فقط في الصفحة الرئيسية`,
      });
    }

    comp.isFeatured = true;
    if (comp.status === "draft") comp.status = "active";
    await comp.save();

    res.json(toAdminSummary(comp));
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المسابقة غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
};
