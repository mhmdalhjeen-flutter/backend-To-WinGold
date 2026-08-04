const wheelService = require("../services/wheel.service");
const WheelWin = require("../models/wheelWin");
const WheelSpin = require("../models/wheelSpin");
const WheelPrize = require("../models/wheelPrize");
const { PURGE_DAYS } = require("../utils/wheelWinMonitor");
const { processOptionalImage } = require("../utils/imageProcess.util");
const {
  assertNoMongoOperators,
  cleanString,
  numberInRange,
  requireObjectId,
} = require("../utils/inputSecurity.util");

async function buildWheelPrizePayload(body, { partial = false } = {}) {
  assertNoMongoOperators(body, "wheelPrize");
  const payload = {};
  if (!partial || body.name !== undefined) {
    payload.name = cleanString(body.name, { field: "name", max: 120, required: true });
  }
  if (!partial || body.description !== undefined) payload.description = cleanString(body.description, { field: "description", max: 1000 });
  if (!partial || body.icon !== undefined) payload.icon = cleanString(body.icon || "🎁", { field: "icon", max: 20 });
  if (!partial || body.image !== undefined) {
    payload.image = body.image ? await processOptionalImage(body.image, { maxWidth: 800, maxBytes: 800_000 }) : null;
  }
  if (!partial || body.color !== undefined) payload.color = cleanString(body.color || "#6366f1", { field: "color", max: 20 });
  if (!partial || body.minPoints !== undefined) payload.minPoints = numberInRange(body.minPoints ?? 0, { field: "minPoints", min: 0, max: 1_000_000 });
  if (!partial || body.displayWeight !== undefined) payload.displayWeight = numberInRange(body.displayWeight ?? 10, { field: "displayWeight", min: 0, max: 1000 });
  if (!partial || body.winWeight !== undefined) payload.winWeight = numberInRange(body.winWeight ?? 0, { field: "winWeight", min: 0, max: 1000 });
  if (!partial || body.prizeType !== undefined) {
    const prizeType = cleanString(body.prizeType || "item", { field: "prizeType", max: 20 });
    if (!["none", "points", "entries", "item"].includes(prizeType)) {
      throw Object.assign(new Error("prizeType غير صالح"), { status: 400 });
    }
    payload.prizeType = prizeType;
  }
  if (!partial || body.prizeValue !== undefined) payload.prizeValue = numberInRange(body.prizeValue ?? 0, { field: "prizeValue", min: 0, max: 1_000_000 });
  if (!partial || body.isActive !== undefined) payload.isActive = body.isActive === undefined ? true : !!body.isActive;
  if (!partial || body.sortOrder !== undefined) payload.sortOrder = numberInRange(body.sortOrder ?? 0, { field: "sortOrder", min: 0, max: 10000 });
  return payload;
}

exports.getConfig = async (req, res) => {
  try {
    const user = req.user ? await require("../models/user").findById(req.user.id).select("points") : null;
    const config = await wheelService.getPublicConfig(user?.points ?? 0);
    config.userPoints = user?.points ?? 0;
    config.segmentCount = config.segments.length;
    res.json(config);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.spin = async (req, res) => {
  try {
    const idempotencyKey = req.headers["idempotency-key"] || req.body.idempotencyKey;
    const ip = req.ip || req.headers["x-forwarded-for"];
    const result = await wheelService.executeSpin({
      userId: req.user.id,
      idempotencyKey,
      ip: typeof ip === "string" ? ip.split(",")[0].trim() : null,
    });
    const config = await wheelService.getPublicConfig(result.userPoints);
    result.segmentCount = config.segments.length;
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getMyWins = async (req, res) => {
  try {
    const now = new Date();
    const wins = await WheelWin.find({
      user: req.user.id,
      $or: [{ purgeAt: null }, { purgeAt: { $gt: now } }],
    })
      .populate("prize", "name icon color image description prizeType")
      .sort({ wonAt: -1 });
    res.json({ wins });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Admin (full prize data including winWeight) ───

exports.adminListPrizes = async (req, res) => {
  try {
    const prizes = await WheelPrize.find().sort({ sortOrder: 1, createdAt: 1 });
    res.json({ prizes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminCreatePrize = async (req, res) => {
  try {
    const prize = await WheelPrize.create(await buildWheelPrizePayload(req.body || {}));
    res.status(201).json({ prize });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.adminUpdatePrize = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const prize = await WheelPrize.findByIdAndUpdate(id, await buildWheelPrizePayload(req.body || {}, { partial: true }), { new: true, runValidators: true });
    if (!prize) return res.status(404).json({ message: "الجائزة غير موجودة" });
    res.json({ prize });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.adminDeletePrize = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    await WheelPrize.findByIdAndDelete(id);
    res.json({ message: "تم الحذف" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.adminListWins = async (req, res) => {
  try {
    const wins = await WheelWin.find({ hiddenFromAdmin: { $ne: true } })
      .populate("user", "name email phone address")
      .populate("prize", "name icon color")
      .sort({ wonAt: -1 })
      .limit(200);
    res.json({ wins });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateWin = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "wheelWin");
    const body = req.body || {};
    const { deliveryStatus, adminNotes } = body;
    const id = requireObjectId(req.params.id, "id");
    const win = await WheelWin.findById(id);
    if (!win) return res.status(404).json({ message: "السجل غير موجود" });

    if (deliveryStatus) {
      const safeDeliveryStatus = cleanString(deliveryStatus, { field: "deliveryStatus", max: 30 });
      if (!["pending", "contacted", "delivered", "cancelled"].includes(safeDeliveryStatus)) {
        return res.status(400).json({ message: "deliveryStatus غير صالح" });
      }
      win.deliveryStatus = safeDeliveryStatus;
      if (safeDeliveryStatus === "delivered" || safeDeliveryStatus === "cancelled") {
        win.hiddenFromAdmin = true;
        win.purgeAt = new Date(Date.now() + PURGE_DAYS * 24 * 60 * 60 * 1000);
      }
    }
    if (adminNotes !== undefined) win.adminNotes = cleanString(adminNotes, { field: "adminNotes", max: 1000 });
    await win.save();
    await win.populate("user", "name phone address email");
    res.json({ win, message: "تم التحديث" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.adminListSpins = async (req, res) => {
  try {
    const spins = await WheelSpin.find()
      .populate("user", "name")
      .populate("prize", "name")
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ spins });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminPreview = async (req, res) => {
  try {
    const config = await wheelService.getPublicConfig(0);
    const full = await WheelPrize.find({ isActive: true }).sort({ sortOrder: 1 });
    res.json({
      ...config,
      prizes: full,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
