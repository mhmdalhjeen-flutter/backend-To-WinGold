const Offer = require("../models/offer");
const notificationService = require("../services/notification.service");
const { safeLog } = require("./logSanitize.util");

const MAX_OFFER_DAYS = 7;

const GRACE_MS = MAX_OFFER_DAYS * 24 * 60 * 60 * 1000;

/**
 * مراقبة العروض:
 * 1. إيقاف العروض عند expiresAt أو بعد 7 أيام (autoDeleteAt).
 * 2. تنبيه قبل expiresAt بـ 24 ساعة.
 * 3. حذف العروض غير المجددة بعد انتهاء فترة السماح (7 أيام بعد expiresAt).
 */
const monitorOffers = async () => {
    try {
        const now = new Date();
        const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const graceCutoff = new Date(now.getTime() - GRACE_MS);

        const expiredOffers = await Offer.find({
            isActive: true,
            $or: [
                { autoDeleteAt: { $lte: now } },
                { expiresAt: { $lte: now } },
            ],
        })
            .select("title store expiresAt expiryWarningSent isActive autoDeleteAt")
            .populate("store", "name owner")
            .lean();

        for (const offer of expiredOffers) {
            await Offer.findByIdAndUpdate(offer._id, { isActive: false });
            if (offer.store?.owner) {
                await notificationService.create({
                    user: offer.store.owner,
                    type: "offer_expired",
                    title: "انتهى عرضك",
                    body: `انتهت صلاحية العرض "${offer.title}" وتم إخفاؤه. يمكنك تجديده إن أردت.`,
                    data: { offerId: offer._id },
                });
            }
        }
        if (expiredOffers.length > 0) {
            safeLog("info", "offer_monitor_expired", { count: expiredOffers.length });
        }

        const pendingWarnings = await Offer.find({
            expiresAt: { $gt: now, $lte: oneDayFromNow },
            isActive: true,
            expiryWarningSent: false,
        })
            .select("title store expiresAt expiryWarningSent")
            .populate("store", "name owner")
            .lean();

        for (const offer of pendingWarnings) {
            if (offer.store?.owner) {
                await notificationService.create({
                    user: offer.store.owner,
                    type: "offer_expiring",
                    title: "عرضك ينتهي خلال 24 ساعة",
                    body: `العرض "${offer.title}" ينتهي قريباً. جدّده الآن إذا أردت الإبقاء عليه.`,
                    data: { offerId: offer._id },
                });
            }
            await Offer.findByIdAndUpdate(offer._id, { expiryWarningSent: true });
        }
        if (pendingWarnings.length > 0) {
            safeLog("info", "offer_monitor_warning_sent", { count: pendingWarnings.length });
        }

        const purgeResult = await Offer.deleteMany({
            isActive: false,
            expiresAt: { $lte: graceCutoff },
        });
        if (purgeResult.deletedCount > 0) {
            safeLog("info", "offer_monitor_grace_purged", { count: purgeResult.deletedCount });
        }
    } catch (error) {
        safeLog("error", "offer_monitor_failed", { message: error.message });
    }
};

module.exports = monitorOffers;
