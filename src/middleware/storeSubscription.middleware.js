const Store = require("../models/store");
const storeSubscriptionService = require("../services/storeSubscription.service");
const { SUBSCRIPTION_STATUSES } = require("../constants/storeSubscription.constants");

const SUBSCRIPTION_MESSAGE = "يرجى تجديد الاشتراك للدخول إلى لوحة المتجر";
const PAYMENT_REJECTED_MESSAGE = "تم رفض بيانات الدفع. يرجى مراجعة الدفع وإعادة الإرسال.";

function isSubscriptionActive(store) {
  return store?.subscriptionActive !== false;
}

/** Blocks only manual subscription disable — allows payment_pending and payment_rejected flows. */
async function requireStoreOwnerAccount(req, res, next) {
  try {
    if (req.user?.role !== "store") return next();

    const store = await Store.findOne({ owner: req.user.id }).select("subscriptionActive").lean();
    if (!store) return next();
    if (!isSubscriptionActive(store)) {
      return res.status(403).json({
        message: SUBSCRIPTION_MESSAGE,
        subscriptionExpired: true,
      });
    }
    next();
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

/** Blocks store owners when subscription is manually disabled or payment was rejected. */
async function requireStoreSubscription(req, res, next) {
  try {
    if (req.user?.role !== "store") return next();

    const store = await Store.findOne({ owner: req.user.id })
      .select("subscriptionActive")
      .lean();
    if (!store) return next();

    if (!isSubscriptionActive(store)) {
      return res.status(403).json({
        message: SUBSCRIPTION_MESSAGE,
        subscriptionExpired: true,
      });
    }

    const statusPayload = await storeSubscriptionService.getStoreSubscriptionStatus(store._id);
    req.storeSubscription = statusPayload;

    if (statusPayload.paymentRejected) {
      return res.status(403).json({
        message: PAYMENT_REJECTED_MESSAGE,
        subscriptionPaymentRejected: true,
        rejectionReason: statusPayload.period?.rejectionReason || "",
        subscriptionStatus: SUBSCRIPTION_STATUSES.PAYMENT_REJECTED,
      });
    }

    if (statusPayload.paymentPending) {
      req.subscriptionPaymentPending = true;
    }

    next();
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

module.exports = {
  requireStoreSubscription,
  requireStoreOwnerAccount,
  isSubscriptionActive,
  SUBSCRIPTION_MESSAGE,
  PAYMENT_REJECTED_MESSAGE,
};
