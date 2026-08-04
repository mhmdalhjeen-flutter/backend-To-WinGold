const mongoose = require("mongoose");
const PromoCode = require("../models/promoCode");
const AdminCode = require("../models/AdminCode");
const Store = require("../models/store");
const User = require("../models/user");
const SystemSetting = require("../models/systemSetting");
const logActivity = require("../utils/logger");
const auditService = require("../services/audit.service");
const { generatePromoCodeString, extractCodePrefix, isLegacyPromoCode } = require("../utils/promoCode.util");
const membershipService = require("../services/storeMembership.service");
const {
  atomicClaimPromo,
  atomicClaimRegistrationPromo,
  atomicClaimAdminCode,
  rollbackPromoClaim,
  rollbackAdminCodeClaim,
  rollbackRegistrationPromoClaim,
} = require("../utils/atomicRedeem.util");
const { resolveRegistrationRole } = require("../utils/registrationRole.util");
const {
  assertNoMongoOperators,
  cleanString,
  intInRange,
  requireObjectId,
} = require("../utils/inputSecurity.util");

function isTransactionUnsupported(err) {
  return (
    err.message?.includes("Transaction numbers") ||
    err.code === 20 ||
    err.code === 251 ||
    err.code === 263
  );
}

async function applyJoinEnergyIfEligible(userId, storeId, session) {
  const joinEnergySetting = await SystemSetting.findOne({ key: "store_join_energy" });
  const parsed = joinEnergySetting ? parseInt(joinEnergySetting.value, 10) : 50;
  const energyValue = Number.isFinite(parsed) ? parsed : 50;

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: userId, storesEnergyClaimed: { $ne: storeId } },
    { $inc: { energy: energyValue }, $addToSet: { storesEnergyClaimed: storeId } },
    opts
  );
  return updated ? energyValue : 0;
}

function buildPromoUserUpdate(promo) {
  return {
    $inc: {
      points: promo.rewardPoints || 0,
      entriesWallet: promo.rewardEntries || 0,
      codesUsed: 1,
    },
  };
}

async function grantPromoRewards({ normalizedCode, userId, store, session }) {
  const promo = await atomicClaimPromo(normalizedCode, userId, session);
  if (!promo) return null;

  const userUpdate = buildPromoUserUpdate(promo);
  const updateOpts = { new: true };
  if (session) updateOpts.session = session;

  const user = await User.findByIdAndUpdate(userId, userUpdate, updateOpts);
  if (!user) {
    throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
  }

  const energyEarned = await applyJoinEnergyIfEligible(userId, store._id, session);

  const storeOpts = session ? { session } : {};
  await Store.findByIdAndUpdate(store._id, { $inc: { codesEntered: 1 } }, storeOpts);

  return { promo, user, energyEarned };
}

async function redeemStorePromo({ normalizedCode, userId, store }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await grantPromoRewards({
      normalizedCode,
      userId,
      store,
      session,
    });
    if (!result) {
      await session.abortTransaction().catch(() => {});
      return null;
    }
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (isTransactionUnsupported(err)) {
      return redeemStorePromoFallback({ normalizedCode, userId, store });
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function redeemStorePromoFallback({ normalizedCode, userId, store }) {
  const promo = await atomicClaimPromo(normalizedCode, userId);
  if (!promo) return null;

  try {
    const userUpdate = buildPromoUserUpdate(promo);
    const user = await User.findByIdAndUpdate(userId, userUpdate, { new: true });
    if (!user) {
      throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
    }
    const energyEarned = await applyJoinEnergyIfEligible(userId, store._id);
    await Store.findByIdAndUpdate(store._id, { $inc: { codesEntered: 1 } });
    return { promo, user, energyEarned };
  } catch (err) {
    await rollbackPromoClaim(normalizedCode, userId);
    throw err;
  }
}

async function grantAdminRewards({ normalizedCode, userId, session }) {
  const adminCode = await atomicClaimAdminCode(normalizedCode, userId, session);
  if (!adminCode) return null;

  const updateOpts = { new: true };
  if (session) updateOpts.session = session;

  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        points: adminCode.rewardPoints || 0,
        codesUsed: 1,
      },
    },
    updateOpts
  );
  if (!user) {
    throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
  }

  return { adminCode, user };
}

async function redeemAdminPromo({ normalizedCode, userId }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await grantAdminRewards({ normalizedCode, userId, session });
    if (!result) {
      await session.abortTransaction().catch(() => {});
      return null;
    }
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (isTransactionUnsupported(err)) {
      return redeemAdminPromoFallback({ normalizedCode, userId });
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function redeemAdminPromoFallback({ normalizedCode, userId }) {
  const adminCode = await atomicClaimAdminCode(normalizedCode, userId);
  if (!adminCode) return null;

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          points: adminCode.rewardPoints || 0,
          codesUsed: 1,
        },
      },
      { new: true }
    );
    if (!user) {
      throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
    }
    return { adminCode, user };
  } catch (err) {
    await rollbackAdminCodeClaim(normalizedCode, userId);
    throw err;
  }
}

async function grantRegistrationRole({ normalizedCode, userId, session }) {
  const promo = await atomicClaimRegistrationPromo(normalizedCode, userId, session);
  if (!promo) return null;

  const role = resolveRegistrationRole(promo, normalizedCode);
  if (!role) {
    await rollbackRegistrationPromoClaim(normalizedCode, userId, session);
    throw Object.assign(new Error("كود التفعيل غير صالح — لا يمكن تحديد نوع الحساب"), {
      status: 400,
    });
  }

  const updateOpts = { new: true };
  if (session) updateOpts.session = session;

  const user = await User.findByIdAndUpdate(userId, { $set: { role } }, updateOpts);
  if (!user) {
    throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
  }

  return { promo, user, role };
}

async function redeemRegistrationPromo({ normalizedCode, userId }) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await grantRegistrationRole({ normalizedCode, userId, session });
    if (!result) {
      await session.abortTransaction().catch(() => {});
      return null;
    }
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (isTransactionUnsupported(err)) {
      return redeemRegistrationPromoFallback({ normalizedCode, userId });
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function redeemRegistrationPromoFallback({ normalizedCode, userId }) {
  const promo = await atomicClaimRegistrationPromo(normalizedCode, userId);
  if (!promo) return null;

  const role = resolveRegistrationRole(promo, normalizedCode);
  if (!role) {
    await rollbackRegistrationPromoClaim(normalizedCode, userId);
    throw Object.assign(new Error("كود التفعيل غير صالح — لا يمكن تحديد نوع الحساب"), {
      status: 400,
    });
  }

  try {
    const user = await User.findByIdAndUpdate(userId, { $set: { role } }, { new: true });
    if (!user) {
      throw Object.assign(new Error("المستخدم غير موجود"), { status: 404 });
    }
    return { promo, user, role };
  } catch (err) {
    await rollbackRegistrationPromoClaim(normalizedCode, userId);
    throw err;
  }
}

async function promoRedeemErrorMessage(code, userId) {
  const promo = await PromoCode.findOne({ code });
  if (!promo) return "الكود غير صالح أو منتهي الصلاحية";
  if (promo.isRegistrationCode) return "الكود غير صالح أو منتهي الصلاحية";
  if (promo.usedBy.some((u) => u.user.toString() === userId)) {
    return "لقد قمت باستخدام هذا الكود من قبل";
  }
  if (!promo.isActive || promo.currentUses >= promo.maxUses) {
    return "الكود غير صالح أو منتهي الصلاحية";
  }
  return "الكود غير صالح أو منتهي الصلاحية";
}

async function adminRedeemErrorMessage(code, userId) {
  const adminCode = await AdminCode.findOne({ code });
  if (!adminCode) return "الكود غير صالح أو منتهي الصلاحية";
  if (adminCode.usedBy.some((u) => u.user.toString() === userId)) {
    return "لقد قمت باستخدام هذا الكود من قبل";
  }
  if (!adminCode.isActive || adminCode.currentUses >= adminCode.maxUses) {
    return "الكود غير صالح أو منتهي الصلاحية";
  }
  return "الكود غير صالح أو منتهي الصلاحية";
}

exports.redeemCode = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "redeem");
    const code = cleanString(req.body.code, { field: "code", max: 80 });
    if (!code) {
      return res.status(400).json({ message: "الكود مطلوب" });
    }

    const normalizedCode = code.trim().toUpperCase();
    const userId = req.user.id;

    const promoPreview = await PromoCode.findOne({ code: normalizedCode });

    if (promoPreview && promoPreview.isActive && !promoPreview.isRegistrationCode) {
      if (!promoPreview.store) {
        return res.status(400).json({ message: "هذا الكود غير مرتبط بمتجر" });
      }

      const store = await Store.findById(promoPreview.store);
      if (!store) {
        return res.status(400).json({ message: "المتجر المرتبط بالكود غير موجود" });
      }

      if (!isLegacyPromoCode(normalizedCode) && store.codePrefix) {
        const codePrefix = extractCodePrefix(normalizedCode);
        if (codePrefix !== store.codePrefix) {
          return res.status(400).json({ message: "هذا الكود لا ينتمي لهذا المتجر" });
        }
      }

      const redeemed = await redeemStorePromo({
        normalizedCode,
        userId,
        store,
      });
      if (!redeemed) {
        await auditService.logSensitiveOperation(req, {
          action: "محاولة استرداد كود فاشلة",
          details: `كود: ${normalizedCode}`,
          success: false,
          metadata: { code: normalizedCode, storeId: String(store._id) },
        });
        return res.status(400).json({
          message: await promoRedeemErrorMessage(normalizedCode, userId),
        });
      }

      const { promo, user, energyEarned } = redeemed;

      const newlyMember = !!(await membershipService.upgradeToMember(userId, store._id));

      await logActivity({
        action: "استرداد كود",
        details: `الزبون ${user.name} استرد كود ${normalizedCode} من متجر ${store.name}`,
        user: userId,
        store: store._id,
      });

      await auditService.logSensitiveOperation(req, {
        action: "استرداد كود",
        details: `كود ${normalizedCode} — متجر ${store.name}`,
        user,
        metadata: {
          code: normalizedCode,
          storeId: String(store._id),
          points: promo.rewardPoints || 0,
          energy: energyEarned,
        },
      });

      return res.json({
        message: "تم استرداد الكود بنجاح",
        rewards: {
          points: promo.rewardPoints || 0,
          entries: promo.rewardEntries || 0,
          energy: energyEarned,
        },
        userPoints: user.points,
        userEnergy: user.energy,
        storeId: store._id,
        storeName: store.name,
        autoFollowed: newlyMember,
        membershipStatus: "member",
      });
    }

    const adminPreview = await AdminCode.findOne({ code: normalizedCode });
    if (adminPreview?.isActive) {
      const redeemed = await redeemAdminPromo({ normalizedCode, userId });
      if (!redeemed) {
        await auditService.logSensitiveOperation(req, {
          action: "محاولة استرداد كود أدمن فاشلة",
          details: `كود: ${normalizedCode}`,
          success: false,
          metadata: { code: normalizedCode },
        });
        return res.status(400).json({
          message: await adminRedeemErrorMessage(normalizedCode, userId),
        });
      }

      const { adminCode, user } = redeemed;

      await logActivity({
        action: "استرداد كود أدمن",
        details: `الزبون ${user.name} استرد كود أدمن ${normalizedCode}`,
        user: userId,
      });

      await auditService.logSensitiveOperation(req, {
        action: "استرداد كود أدمن",
        details: `كود ${normalizedCode}`,
        user,
        metadata: { code: normalizedCode, points: adminCode.rewardPoints || 0 },
      });

      return res.json({
        message: "تم استرداد الكود بنجاح",
        codeType: "admin",
        rewards: {
          points: adminCode.rewardPoints || 0,
          entries: 0,
          energy: 0,
        },
        userPoints: user.points,
        userEnergy: user.energy,
      });
    }

    return res.status(400).json({ message: "الكود غير صالح أو منتهي الصلاحية" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.redeemActivationCode = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "activation");
    const code = cleanString(req.body.code, { field: "code", max: 80 });
    if (!code) {
      return res.status(400).json({ message: "كود تفعيل غير صحيح" });
    }

    const normalizedCode = code.trim().toUpperCase();
    const userId = req.user.id;

    const redeemed = await redeemRegistrationPromo({ normalizedCode, userId });
    if (!redeemed) {
      await auditService.logSensitiveOperation(req, {
        action: "محاولة تفعيل حساب فاشلة",
        details: `كود: ${normalizedCode}`,
        success: false,
        metadata: { code: normalizedCode },
      });
      const existing = await PromoCode.findOne({ code: normalizedCode, isRegistrationCode: true });
      if (existing?.usedBy.some((u) => u.user.toString() === userId)) {
        return res.status(400).json({ message: "لقد قمت باستخدام هذا الكود من قبل" });
      }
      return res.status(400).json({ message: "كود تفعيل غير صحيح" });
    }

    await auditService.logSensitiveOperation(req, {
      action: "تفعيل حساب بكود",
      details: `كود ${normalizedCode} — دور ${redeemed.role}`,
      user: redeemed.user,
      metadata: { code: normalizedCode, role: redeemed.role },
    });

    res.json({ message: "تم تفعيل الحساب بنجاح" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createPromoCode = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "promoCode");
    const storeId = requireObjectId(req.body.store, "store");
    if (!storeId) {
      return res.status(400).json({ message: "المتجر مطلوب لإنشاء الكود" });
    }
    const store = await Store.findById(storeId);
    if (!store?.codePrefix) {
      return res.status(400).json({ message: "المتجر لا يملك بصمة أكواد بعد" });
    }

    const code = generatePromoCodeString(store.codePrefix);
    const registrationRole = cleanString(req.body.registrationRole, { field: "registrationRole", max: 20 });
    if (registrationRole && !["store", "supplier"].includes(registrationRole)) {
      return res.status(400).json({ message: "registrationRole غير صالح" });
    }
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ message: "expiresAt غير صالح" });
    }
    const promo = await PromoCode.create({
      code,
      store: storeId,
      createdBy: req.user.id,
      rewardPoints: intInRange(req.body.rewardPoints ?? 0, { field: "rewardPoints", min: 0, max: 1_000_000 }),
      rewardEntries: intInRange(req.body.rewardEntries ?? 0, { field: "rewardEntries", min: 0, max: 1_000_000 }),
      isRegistrationCode: !!req.body.isRegistrationCode,
      registrationRole: registrationRole || undefined,
      batchName: cleanString(req.body.batchName, { field: "batchName", max: 120 }),
      isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
      maxUses: intInRange(req.body.maxUses ?? 1, { field: "maxUses", min: 1, max: 100000 }),
      expiresAt,
    });
    res.json({ message: "تم إنشاء الكود بنجاح", promo });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getCodeStats = async (req, res) => {
  try {
    if (req.user.role === "admin") {
      const totalCodes = await PromoCode.countDocuments();
      const activeCodes = await PromoCode.countDocuments({ isActive: true });
      return res.json({ totalCodes, activeCodes, scope: "global" });
    }

    const store = await Store.findOne({ owner: req.user.id }).select("_id");
    if (!store) {
      return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });
    }

    const totalCodes = await PromoCode.countDocuments({ store: store._id });
    const activeCodes = await PromoCode.countDocuments({ store: store._id, isActive: true });
    res.json({ totalCodes, activeCodes, scope: "store", storeId: store._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
