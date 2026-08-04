const Store = require("../models/store");

const SUBSCRIPTION_MESSAGE = "يرجى تجديد الاشتراك للدخول إلى لوحة المتجر";

function isSubscriptionActive(store) {
  return store?.subscriptionActive !== false;
}

/** يمنع أصحاب المتاجر (role=store) من استخدام لوحة التحكم عند انتهاء الاشتراك */
async function requireStoreSubscription(req, res, next) {
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

module.exports = {
  requireStoreSubscription,
  isSubscriptionActive,
  SUBSCRIPTION_MESSAGE,
};
