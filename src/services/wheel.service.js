const crypto = require("crypto");
const mongoose = require("mongoose");
const WheelPrize = require("../models/wheelPrize");
const WheelSpin = require("../models/wheelSpin");
const WheelWin = require("../models/wheelWin");
const User = require("../models/user");
const platformSettings = require("../services/platformSettings.service");

const DEFAULT_SPIN_COST = 5;

async function getSpinCost() {
  const wheel = await platformSettings.getWheelSettings();
  return wheel.spinCost;
}

async function getSpinIntervalMs() {
  const wheel = await platformSettings.getWheelSettings();
  return wheel.spinIntervalMs;
}

async function isWheelEnabled() {
  const wheel = await platformSettings.getWheelSettings();
  return wheel.enabled;
}

function securePick(weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  const scaled = Math.floor(total * 1000);
  if (scaled <= 0) return 0;
  const r = crypto.randomInt(0, scaled) / 1000;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

async function getActivePrizes() {
  return WheelPrize.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
}

async function getPublicConfig(userPoints = 0) {
  const wheelSettings = await platformSettings.getWheelSettings();
  const prizes = wheelSettings.enabled ? await getActivePrizes() : [];
  const spinCost = wheelSettings.spinCost;
  const segments = prizes.map((p, index) => ({
    _id: p._id,
    index,
    name: p.name,
    description: p.description,
    icon: p.icon,
    image: p.image,
    color: p.color,
    minPoints: p.minPoints,
    displayWeight: p.displayWeight,
    locked: userPoints < p.minPoints,
    prizeType: p.prizeType,
  }));
  return {
    enabled: wheelSettings.enabled,
    spinCost,
    placements: wheelSettings.placements,
    segments,
  };
}

async function assertSpinRateLimit(userId, minInterval, session) {
  const cutoff = new Date(Date.now() - minInterval);
  let q = WheelSpin.findOne({ user: userId, createdAt: { $gte: cutoff } })
    .sort({ createdAt: -1 });
  if (session) q = q.session(session);
  const recent = await q;
  if (recent) {
    const err = new Error("انتظر قليلاً قبل الدوران مرة أخرى");
    err.status = 429;
    throw err;
  }
}

async function applyPointsChange(userId, pointsCost, outcome, picked, session) {
  const opts = { new: true };
  if (session) opts.session = session;

  if (pointsCost > 0) {
    let pointDelta = -pointsCost;
    if (outcome === "win" && picked.prizeType === "points" && picked.prizeValue > 0) {
      pointDelta += picked.prizeValue;
    }
    const updated = await User.findOneAndUpdate(
      { _id: userId, points: { $gte: pointsCost } },
      { $inc: { points: pointDelta } },
      opts
    );
    if (!updated) {
      const err = new Error(`تحتاج ${pointsCost} نقاط على الأقل للدوران`);
      err.status = 400;
      throw err;
    }
    if (outcome === "win" && picked.prizeType === "entries" && picked.prizeValue > 0) {
      await User.findByIdAndUpdate(
        userId,
        { $inc: { entriesWallet: picked.prizeValue } },
        session ? { session } : {}
      );
    }
    return updated.points;
  }

  if (outcome === "win") {
    const inc = {};
    if (picked.prizeType === "points" && picked.prizeValue > 0) inc.points = picked.prizeValue;
    if (picked.prizeType === "entries" && picked.prizeValue > 0) {
      inc.entriesWallet = picked.prizeValue;
    }
    if (Object.keys(inc).length) {
      const updated = await User.findByIdAndUpdate(userId, { $inc: inc }, opts);
      return updated?.points ?? 0;
    }
  }

  const userQuery = User.findById(userId).select("points");
  if (session) userQuery.session(session);
  const user = await userQuery;
  return user?.points ?? 0;
}

async function persistSpinRecords({
  userId,
  picked,
  outcome,
  pointsCost,
  pointsBefore,
  pointsAfter,
  segmentIndex,
  idempotencyKey,
  ip,
  session,
}) {
  const spinPayload = {
    user: userId,
    prize: picked._id,
    outcome,
    pointsCost,
    pointsBefore,
    pointsAfter,
    segmentIndex: segmentIndex >= 0 ? segmentIndex : 0,
    idempotencyKey: idempotencyKey || undefined,
    ip,
    meta: { prizeName: picked.name, prizeType: picked.prizeType },
  };

  let spinDoc;
  try {
    if (session) {
      const created = await WheelSpin.create([spinPayload], { session });
      spinDoc = created[0];
    } else {
      spinDoc = await WheelSpin.create(spinPayload);
    }
  } catch (err) {
    if (err.code === 11000 && idempotencyKey) {
      const dup = await WheelSpin.findOne({ idempotencyKey });
      if (dup) {
        const replay = new Error("IDEMPOTENCY_REPLAY");
        replay.spin = dup;
        throw replay;
      }
    }
    throw err;
  }

  let winRecord = null;
  if (outcome === "win") {
    const user = await User.findById(userId).select("name phone address");
    const winPayload = {
      user: userId,
      prize: picked._id,
      spin: spinDoc._id,
      userName: user?.name || "",
      userPhone: user?.phone || "",
      userAddress: user?.address || "",
      prizeName: picked.name,
      wonAt: new Date(),
    };
    if (session) {
      const created = await WheelWin.create([winPayload], { session });
      winRecord = created[0];
    } else {
      winRecord = await WheelWin.create(winPayload);
    }
  }

  return { spinDoc, winRecord };
}

async function computeSpinOutcome(userId, spinCost, prizes) {
  const winCandidates = prizes.filter((p) => p.winWeight > 0);
  if (!winCandidates.length) {
    const err = new Error("لا توجد جوائز قابلة للفوز");
    err.status = 503;
    throw err;
  }

  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("المستخدم غير موجود");
    err.status = 404;
    throw err;
  }

  const pickIndex = securePick(winCandidates.map((p) => p.winWeight));
  const picked = winCandidates[pickIndex];
  const segmentIndex = prizes.findIndex((p) => String(p._id) === String(picked._id));

  let outcome;
  let pointsCost = 0;

  if (user.points < picked.minPoints) {
    outcome = "locked";
    pointsCost = 0;
  } else if (picked.prizeType === "none") {
    outcome = "no_win";
    pointsCost = spinCost;
  } else {
    outcome = "win";
    pointsCost = spinCost;
  }

  return {
    user,
    picked,
    segmentIndex,
    outcome,
    pointsCost,
    pointsBefore: user.points,
  };
}

async function executeSpinWithSession({ userId, idempotencyKey, ip, session }) {
  if (!(await isWheelEnabled())) {
    const err = new Error("عجلة الحظ معطّلة حالياً");
    err.status = 503;
    throw err;
  }

  if (idempotencyKey) {
    const dup = await WheelSpin.findOne({ idempotencyKey }).session(session);
    if (dup) {
      await session.abortTransaction();
      return rebuildSpinResponse(dup, userId);
    }
  }

  const minInterval = await getSpinIntervalMs();
  await assertSpinRateLimit(userId, minInterval, session);

  const spinCost = await getSpinCost();
  const prizes = await getActivePrizes();
  if (!prizes.length) {
    const err = new Error("العجلة غير مهيّأة حالياً");
    err.status = 503;
    throw err;
  }

  const { picked, segmentIndex, outcome, pointsCost, pointsBefore } =
    await computeSpinOutcome(userId, spinCost, prizes);

  if (outcome !== "locked" && pointsCost > 0) {
    const user = await User.findById(userId).select("points").session(session);
    if (!user || user.points < pointsCost) {
      const err = new Error(`تحتاج ${spinCost} نقاط على الأقل للدوران`);
      err.status = 400;
      throw err;
    }
  }

  const pointsAfter = await applyPointsChange(userId, pointsCost, outcome, picked, session);

  const { spinDoc, winRecord } = await persistSpinRecords({
    userId,
    picked,
    outcome,
    pointsCost,
    pointsBefore,
    pointsAfter,
    segmentIndex,
    idempotencyKey,
    ip,
    session,
  });

  return formatSpinResult({
    spin: spinDoc,
    picked,
    segmentIndex,
    outcome,
    pointsCost,
    userPoints: pointsAfter,
    win: winRecord,
  });
}

async function executeSpinWithoutSession({ userId, idempotencyKey, ip }) {
  if (!(await isWheelEnabled())) {
    const err = new Error("عجلة الحظ معطّلة حالياً");
    err.status = 503;
    throw err;
  }

  if (idempotencyKey) {
    const dup = await WheelSpin.findOne({ idempotencyKey });
    if (dup) {
      return rebuildSpinResponse(dup, userId);
    }
  }

  const minInterval = await getSpinIntervalMs();
  await assertSpinRateLimit(userId, minInterval, null);

  const spinCost = await getSpinCost();
  const prizes = await getActivePrizes();
  if (!prizes.length) {
    const err = new Error("العجلة غير مهيّأة حالياً");
    err.status = 503;
    throw err;
  }

  const { picked, segmentIndex, outcome, pointsCost, pointsBefore } =
    await computeSpinOutcome(userId, spinCost, prizes);

  if (outcome !== "locked" && pointsCost > 0) {
    const user = await User.findById(userId).select("points");
    if (!user || user.points < pointsCost) {
      const err = new Error(`تحتاج ${spinCost} نقاط على الأقل للدوران`);
      err.status = 400;
      throw err;
    }
  }

  let pointsAfter = pointsBefore;
  let spinDoc = null;

  try {
    pointsAfter = await applyPointsChange(userId, pointsCost, outcome, picked, null);
    const persisted = await persistSpinRecords({
      userId,
      picked,
      outcome,
      pointsCost,
      pointsBefore,
      pointsAfter,
      segmentIndex,
      idempotencyKey,
      ip,
      session: null,
    });
    spinDoc = persisted.spinDoc;
    return formatSpinResult({
      spin: spinDoc,
      picked,
      segmentIndex,
      outcome,
      pointsCost,
      userPoints: pointsAfter,
      win: persisted.winRecord,
    });
  } catch (err) {
    if (err.message === "IDEMPOTENCY_REPLAY" && err.spin) {
      return rebuildSpinResponse(err.spin, userId);
    }
    if (pointsCost > 0 && spinDoc == null) {
      const refundDelta = pointsCost - (outcome === "win" && picked.prizeType === "points" ? picked.prizeValue : 0);
      if (refundDelta !== 0) {
        await User.findByIdAndUpdate(userId, { $inc: { points: -refundDelta } });
      }
      if (outcome === "win" && picked.prizeType === "entries" && picked.prizeValue > 0) {
        await User.findByIdAndUpdate(userId, { $inc: { entriesWallet: -picked.prizeValue } });
      }
    }
    throw err;
  }
}

async function executeSpin({ userId, idempotencyKey, ip }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await executeSpinWithSession({ userId, idempotencyKey, ip, session });
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (err.message === "IDEMPOTENCY_REPLAY" && err.spin) {
      return rebuildSpinResponse(err.spin, userId);
    }
    if (
      err.message?.includes("Transaction numbers") ||
      err.code === 20 ||
      err.code === 251 ||
      err.code === 263
    ) {
      return executeSpinWithoutSession({ userId, idempotencyKey, ip });
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function rebuildSpinResponse(spin, userId) {
  if (String(spin.user) !== String(userId)) {
    const err = new Error("مفتاح مكرّر");
    err.status = 409;
    throw err;
  }
  const picked = await WheelPrize.findById(spin.prize);
  const user = await User.findById(userId);
  const win = spin.outcome === "win" ? await WheelWin.findOne({ spin: spin._id }) : null;
  return formatSpinResult({
    spin,
    picked,
    segmentIndex: spin.segmentIndex,
    outcome: spin.outcome,
    pointsCost: spin.pointsCost,
    userPoints: user?.points ?? spin.pointsAfter,
    win,
  });
}

function formatSpinResult({ spin, picked, segmentIndex, outcome, pointsCost, userPoints, win }) {
  const messages = {
    win: `مبروك! فزت بـ ${picked?.name || "جائزة"}`,
    no_win: "حظاً أوفر في المرة القادمة",
    locked: `هذه الجائزة تحتاج ${picked?.minPoints || 0} نقطة — أنت عند ${userPoints} نقطة`,
  };
  return {
    spinId: spin._id,
    outcome,
    charged: pointsCost > 0,
    pointsCost,
    userPoints,
    segmentIndex,
    segmentCount: null,
    prize: picked
      ? {
          _id: picked._id,
          name: picked.name,
          icon: picked.icon,
          color: picked.color,
          image: picked.image,
          minPoints: picked.minPoints,
          prizeType: picked.prizeType,
          prizeValue: picked.prizeValue,
        }
      : null,
    winId: win?._id || null,
    message: messages[outcome] || "",
  };
}

module.exports = {
  getSpinCost,
  getSpinIntervalMs,
  isWheelEnabled,
  getPublicConfig,
  getActivePrizes,
  executeSpin,
  DEFAULT_SPIN_COST,
};
