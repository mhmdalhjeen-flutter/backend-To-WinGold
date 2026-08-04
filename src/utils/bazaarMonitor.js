const BazaarListing = require("../models/bazaarListing");
const notificationService = require("../services/notification.service");
const { safeLog } = require("./logSanitize.util");

const LISTING_DAYS = BazaarListing.LISTING_DAYS;

/**
 * دورة حياة إعلانات BazaarX:
 * 1. إخفاء المنتهية وتحديث status إلى expired.
 * 2. تنبيه البائع قبل انتهاء المدة (هل تريد التجديد؟).
 */
const monitorBazaarListings = async () => {
  try {
    const now = new Date();
    const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    const expired = await BazaarListing.find({
      status: "approved",
      isVisible: true,
      expiresAt: { $lte: now },
    });

    for (const listing of expired) {
      listing.isVisible = false;
      listing.status = "expired";
      await listing.save();

      await notificationService.create({
        user: listing.seller,
        type: "bazaar_listing_expired",
        title: "انتهت مدة إعلانك في BazaarX",
        body: `إعلان "${listing.title}" لم يعد ظاهراً. يمكنك تجديده مقابل 3 نقاط.`,
        data: { listingId: listing._id, canRenew: true },
      });
    }

    if (expired.length > 0) {
      safeLog("info", "bazaar_monitor_expired", { count: expired.length });
    }

    const pendingRenewal = await BazaarListing.find({
      status: "approved",
      isVisible: true,
      expiresAt: { $gt: now, $lte: twoDaysFromNow },
      renewalWarningSent: false,
    });

    for (const listing of pendingRenewal) {
      await notificationService.create({
        user: listing.seller,
        type: "bazaar_renewal_prompt",
        title: "هل تريد تجديد إعلانك؟",
        body: `إعلان "${listing.title}" ينتهي قريباً. التجديد يكلف 3 نقاط ويمدّد ${LISTING_DAYS} أيام.`,
        data: { listingId: listing._id, canRenew: true },
      });
      listing.renewalWarningSent = true;
      await listing.save();
    }

    if (pendingRenewal.length > 0) {
      safeLog("info", "bazaar_monitor_renewal_warning_sent", { count: pendingRenewal.length });
    }
  } catch (err) {
    safeLog("error", "bazaar_monitor_failed", { message: err.message });
  }
};

module.exports = monitorBazaarListings;
