const Notification = require("../models/notification");
const PushDevice = require("../models/pushDevice");
const { getVapidPublicKey } = require("../config/vapid");
const cache = require("../utils/responseCache.util");

const PUSH_APPS = new Set(["customer", "store"]);

function normalizePushSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return null;
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return {
    endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

exports.getPushPublicKey = async (req, res) => {
  try {
    const publicKey = getVapidPublicKey();
    if (!publicKey) {
      return res.status(503).json({ message: "Push notifications are not configured" });
    }
    res.json({ publicKey });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.subscribePush = async (req, res) => {
  try {
    const { app, platform = "web", subscription } = req.body || {};

    if (!PUSH_APPS.has(app)) {
      return res.status(400).json({ message: 'app must be "customer" or "store"' });
    }
    if (platform !== "web") {
      return res.status(400).json({ message: 'platform must be "web"' });
    }

    const normalized = normalizePushSubscription(subscription);
    if (!normalized) {
      return res.status(400).json({ message: "Invalid push subscription" });
    }

    const device = await PushDevice.findOneAndUpdate(
      { "subscription.endpoint": normalized.endpoint },
      {
        userId: req.user.id,
        app,
        platform: "web",
        subscription: normalized,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      device: {
        id: device._id,
        app: device.app,
        platform: device.platform,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.unsubscribePush = async (req, res) => {
  try {
    const endpoint =
      req.body?.subscription?.endpoint ||
      req.body?.endpoint ||
      "";

    if (!endpoint || typeof endpoint !== "string") {
      return res.status(400).json({ message: "subscription.endpoint is required" });
    }

    const result = await PushDevice.deleteOne({
      userId: req.user.id,
      "subscription.endpoint": endpoint.trim(),
    });

    res.json({ ok: true, removed: result.deletedCount > 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// إشعاراتي (اختياري ?unread=true لغير المقروءة فقط).
exports.getMine = async (req, res) => {
  try {
    const userId = req.user.id;

    // تنظيف خفيف: حذف الإشعارات المقروءة الأقدم من 90 يوماً
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await Notification.deleteMany({
      user: userId,
      read: true,
      createdAt: { $lt: cutoff },
    }).catch(() => {});

    const filter = { user: userId };
    if (req.query.unread === "true") filter.read = false;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const notifications = await Notification.find(filter)
      .select("type title body data read createdAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// عدد غير المقروء (لشارة الجرس).
exports.unreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user.id,
      read: false,
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.markRead = async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: { read: true } },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: "الإشعار غير موجود" });
    cache.invalidate(`notif:unread:${req.user.id}`);
    cache.invalidate(`notif:list:${req.user.id}:`);
    res.json({ notification: notif });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, read: false },
      { $set: { read: true } }
    );
    cache.invalidate(`notif:unread:${req.user.id}`);
    cache.invalidate(`notif:list:${req.user.id}:`);
    res.json({ message: "تم تعليم الكل كمقروء" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
