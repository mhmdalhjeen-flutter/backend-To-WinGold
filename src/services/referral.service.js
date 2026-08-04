const User = require("../models/user");
const platformSettings = require("./platformSettings.service");
const notificationService = require("./notification.service");
const { isUserVerified } = require("../utils/verification.util");
const { safeLog } = require("../utils/logSanitize.util");

const verifiedReferralQuery = {
  $or: [
    { emailVerified: true, email: { $exists: true, $nin: [null, ""] } },
    { phoneVerified: true, phone: { $exists: true, $nin: [null, ""] } },
  ],
};

/**
 * Grant referral points to the referrer only after the referred user verifies
 * their account (email or phone). Idempotent — runs at most once per referred user.
 */
async function tryCompleteReferralReward(referredUserId) {
  if (!referredUserId) return { granted: false };

  const referralEnabled = await platformSettings.isEnabled("referral_program_enabled");
  if (!referralEnabled) return { granted: false };

  const claimed = await User.findOneAndUpdate(
    {
      _id: referredUserId,
      referredBy: { $ne: null },
      referralRewardGranted: { $ne: true },
      ...verifiedReferralQuery,
    },
    {
      referralRewardGranted: true,
      referralCompletedAt: new Date(),
    },
    { new: true }
  ).select("referredBy name");

  if (!claimed?.referredBy) return { granted: false };

  if (String(claimed.referredBy) === String(claimed._id)) {
    return { granted: false };
  }

  const referrer = await User.findById(claimed.referredBy).select("role");
  if (!referrer || referrer.role !== "customer") {
    return { granted: false };
  }

  const reward = await platformSettings.getReferralRewardPoints();
  await User.findByIdAndUpdate(referrer._id, { $inc: { points: reward } });
  await notificationService.queueReferralReward({
    user: referrer._id,
    pointsAdded: reward,
  });

  return { granted: true, points: reward, referrerId: referrer._id };
}

/**
 * Resolve referrer at registration — linked by userId, not email/cookie.
 */
async function resolveReferrer(referralCode, newUserId) {
  if (!referralCode?.trim()) return null;

  const referrer = await User.findOne({
    referralCode: referralCode.trim().toUpperCase(),
    role: "customer",
  }).select("_id");

  if (!referrer) return null;
  if (newUserId && String(referrer._id) === String(newUserId)) return null;

  return referrer;
}

async function countCompletedReferrals(referrerId) {
  return User.countDocuments({
    referredBy: referrerId,
    referralRewardGranted: true,
  });
}

/**
 * One-time: users referred before verification-gated rewards already paid referrers at signup.
 * Mark them complete so verification does not grant duplicate points.
 */
async function backfillReferralRewardFlags() {
  const SystemSetting = require("../models/systemSetting");
  const KEY = "referral_verification_gate_migrated";
  const done = await SystemSetting.findOne({ key: KEY }).select("_id");
  if (done) return;

  const result = await User.updateMany(
    { referredBy: { $ne: null }, referralRewardGranted: { $ne: true } },
    { $set: { referralRewardGranted: true } }
  );

  await SystemSetting.findOneAndUpdate(
    { key: KEY },
    { value: String(result.modifiedCount) },
    { upsert: true }
  );

  if (result.modifiedCount > 0) {
    safeLog("info", "referral_backfill_completed", { count: result.modifiedCount });
  }
}

module.exports = {
  tryCompleteReferralReward,
  resolveReferrer,
  countCompletedReferrals,
  backfillReferralRewardFlags,
  isUserVerified,
};
