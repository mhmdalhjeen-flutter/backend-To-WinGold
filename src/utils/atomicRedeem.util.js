const mongoose = require("mongoose");
const PromoCode = require("../models/promoCode");
const AdminCode = require("../models/AdminCode");
const ActivationCode = require("../models/ActivationCode");

function toObjectId(userId) {
  return new mongoose.Types.ObjectId(userId);
}

/** Atomic push to usedBy + increment currentUses */
function usageUpdate(userId) {
  const uid = toObjectId(userId);
  return {
    $push: { usedBy: { user: uid, usedAt: new Date() } },
    $inc: { currentUses: 1 },
  };
}

function promoRedeemFilter(code, userId) {
  return {
    code,
    isActive: true,
    isRegistrationCode: { $ne: true },
    store: { $exists: true, $ne: null },
    "usedBy.user": { $ne: toObjectId(userId) },
    $expr: { $lt: ["$currentUses", "$maxUses"] },
  };
}

function registrationPromoFilter(code, userId) {
  return {
    code,
    isRegistrationCode: true,
    isActive: true,
    "usedBy.user": { $ne: toObjectId(userId) },
    $expr: { $lt: ["$currentUses", "$maxUses"] },
  };
}

function adminCodeFilter(code, userId) {
  return {
    code,
    isActive: true,
    "usedBy.user": { $ne: toObjectId(userId) },
    $expr: { $lt: ["$currentUses", "$maxUses"] },
  };
}

function activationCodeFilter(code) {
  const now = new Date();
  return {
    code,
    isUsed: false,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

function rollbackUsage(userId) {
  const uid = toObjectId(userId);
  return {
    $pull: { usedBy: { user: uid } },
    $inc: { currentUses: -1 },
  };
}

function claimUpdateOptions(session) {
  const opts = { new: true };
  if (session) opts.session = session;
  return opts;
}

/** Claim usage; deactivates on the final allowed use */
async function claimCodeUsage(Model, filter, userId, session) {
  const update = usageUpdate(userId);
  const opts = claimUpdateOptions(session);
  const lastUseFilter = {
    ...filter,
    $expr: { $eq: [{ $add: ["$currentUses", 1] }, "$maxUses"] },
  };

  return (
    (await Model.findOneAndUpdate(
      lastUseFilter,
      { ...update, $set: { isActive: false } },
      opts
    )) || (await Model.findOneAndUpdate(filter, update, opts))
  );
}

/** Roll back a claim; reactivates when uses drop below maxUses */
async function rollbackCodeUsage(Model, code, userId, session) {
  const uid = toObjectId(userId);
  const filter = { code, "usedBy.user": uid };
  const update = rollbackUsage(userId);
  const opts = claimUpdateOptions(session);
  const reactivateFilter = {
    ...filter,
    isActive: false,
    $expr: { $lt: [{ $subtract: ["$currentUses", 1] }, "$maxUses"] },
  };

  return (
    (await Model.findOneAndUpdate(
      reactivateFilter,
      { ...update, $set: { isActive: true } },
      opts
    )) || (await Model.findOneAndUpdate(filter, update, opts))
  );
}

/** Returns claimed promo doc or null if already used / exhausted / inactive */
async function atomicClaimPromo(code, userId, session) {
  return claimCodeUsage(PromoCode, promoRedeemFilter(code, userId), userId, session);
}

async function atomicClaimRegistrationPromo(code, userId, session) {
  return claimCodeUsage(
    PromoCode,
    registrationPromoFilter(code, userId),
    userId,
    session
  );
}

async function atomicClaimAdminCode(code, userId, session) {
  return claimCodeUsage(AdminCode, adminCodeFilter(code, userId), userId, session);
}

async function rollbackPromoClaim(code, userId, session) {
  return rollbackCodeUsage(PromoCode, code, userId, session);
}

async function rollbackRegistrationPromoClaim(code, userId, session) {
  return rollbackPromoClaim(code, userId, session);
}

async function rollbackAdminCodeClaim(code, userId, session) {
  return rollbackCodeUsage(AdminCode, code, userId, session);
}

/** Returns pre-update doc (includes role) or null */
async function atomicClaimActivationCode(code, userId) {
  return ActivationCode.findOneAndUpdate(
    activationCodeFilter(code),
    { $set: { isUsed: true, usedBy: toObjectId(userId) } },
    { new: false }
  );
}

module.exports = {
  atomicClaimPromo,
  atomicClaimRegistrationPromo,
  atomicClaimAdminCode,
  atomicClaimActivationCode,
  rollbackPromoClaim,
  rollbackRegistrationPromoClaim,
  rollbackAdminCodeClaim,
  promoRedeemFilter,
  adminCodeFilter,
};
