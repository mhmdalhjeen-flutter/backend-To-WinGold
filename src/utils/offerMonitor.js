const Offer = require("../models/offer");
const notificationService = require("../services/notification.service");
const { safeLog } = require("./logSanitize.util");

const WARNING_TITLE = "عرضك ينتهي خلال 24 ساعة";
const WARNING_BODY = "هذا العرض سينتهي خلال 24 ساعة، هل تريد تجديده؟";

/**
 * Offer lifecycle monitor:
 * 1. One 24-hour warning before expiresAt (offer_expiring).
 * 2. Permanent delete when expiresAt is reached and the offer was not renewed.
 */
const monitorOffers = async () => {
    try {
        const now = new Date();
        const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const pendingWarnings = await Offer.find({
            expiresAt: { $gt: now, $lte: oneDayFromNow },
            isActive: true,
            expiryWarningSent: false,
        })
            .select("title store expiresAt expiryWarningSent")
            .populate("store", "name owner")
            .lean();

        for (const offer of pendingWarnings) {
            let warningCreated = false;
            if (offer.store?.owner) {
                const doc = await notificationService.create({
                    user: offer.store.owner,
                    type: "offer_expiring",
                    title: WARNING_TITLE,
                    body: WARNING_BODY,
                    data: { offerId: offer._id },
                });
                warningCreated = Boolean(doc);
            } else {
                warningCreated = true;
            }

            if (warningCreated) {
                await Offer.findByIdAndUpdate(offer._id, { expiryWarningSent: true });
            }
        }
        if (pendingWarnings.length > 0) {
            safeLog("info", "offer_monitor_warning_sent", { count: pendingWarnings.length });
        }

        const expiredCandidates = await Offer.find({
            isActive: true,
            expiresAt: { $lte: now },
        })
            .select("title store expiresAt")
            .populate("store", "name owner")
            .lean();

        let deletedCount = 0;
        for (const offer of expiredCandidates) {
            const deleted = await Offer.findOneAndDelete({
                _id: offer._id,
                isActive: true,
                expiresAt: { $lte: now },
            });

            if (!deleted) continue;
            deletedCount += 1;

            if (offer.store?.owner) {
                await notificationService.create({
                    user: offer.store.owner,
                    type: "offer_expired",
                    title: "انتهى عرضك",
                    body: `انتهت صلاحية العرض "${offer.title}" وتم حذفه.`,
                    data: { offerId: offer._id },
                });
            }
        }
        if (deletedCount > 0) {
            safeLog("info", "offer_monitor_deleted", { count: deletedCount });
        }
    } catch (error) {
        safeLog("error", "offer_monitor_failed", { message: error.message });
    }
};

module.exports = monitorOffers;
module.exports._offerMonitorInternals = {
    WARNING_TITLE,
    WARNING_BODY,
};
