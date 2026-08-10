const Notification = require("../models/notification");
const ReferralBatchBuffer = require("../models/referralBatchBuffer");
const pushService = require("./push.service");
const { safeLog } = require("../utils/logSanitize.util");
const cache = require("../utils/responseCache.util");
const {
  resolvePushTargetApp,
  resolvePushUrl,
} = require("../utils/pushTarget.util");

function buildPushPayload(doc) {
  if (!doc) return null;
  const data =
    doc.data && typeof doc.data === "object" && !Array.isArray(doc.data)
      ? doc.data
      : {};
  const type = doc.type || "general";
  const targetApp = resolvePushTargetApp(type, data);
  const url = resolvePushUrl(targetApp, type, data);

  return {
    title: doc.title,
    body: doc.body || "",
    icon: "/brand/logo-192.webp",
    url,
    type,
    notificationId: String(doc._id),
    targetApp,
    data: {
      type,
      notificationId: String(doc._id),
      url,
      ...data,
    },
  };
}

/** Fire-and-forget Web Push — must never affect MongoDB notification creation. */
function dispatchPushAsync(doc) {
  if (!doc?.user) return;
  const payload = buildPushPayload(doc);
  if (!payload || !payload.targetApp) return;

  setImmediate(() => {
    pushService
      .sendPushToUser(doc.user, payload, {
        app: payload.targetApp,
        platform: "web",
      })
      .catch((err) => {
        safeLog("warn", "push_dispatch_failed", {
          message: err.message,
          userId: String(doc.user),
          type: payload.type,
          app: payload.targetApp,
        });
      });
  });
}

function invalidateNotificationCache(userId) {
  if (!userId) return;
  const uid = String(userId);
  cache.invalidate(`notif:unread:${uid}`);
  cache.invalidate(`notif:list:${uid}:`);
}

function toIdString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value._id != null) return String(value._id);
  return String(value);
}

/**
 * Normalize notification payload data for storage and push.
 * Keeps app-neutral IDs only — route resolution is handled per PWA service worker.
 * Callers may pass url explicitly; relative paths are preserved.
 */
function enrichNotificationData(type, data = {}) {
  const safe =
    data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};

  if (typeof safe.url === "string" && safe.url.startsWith("/")) {
    return safe;
  }

  if (safe.offerId != null) {
    const id = toIdString(safe.offerId);
    if (id) safe.offerId = id;
  }
  if (safe.orderId != null) {
    const id = toIdString(safe.orderId);
    if (id) safe.orderId = id;
  }
  if (safe.deliverySessionId != null) {
    const id = toIdString(safe.deliverySessionId);
    if (id) safe.deliverySessionId = id;
  }
  if (safe.competitionId != null) {
    const id = toIdString(safe.competitionId);
    if (id) safe.competitionId = id;
  }
  if (safe.listingId != null) {
    const id = toIdString(safe.listingId);
    if (id) safe.listingId = id;
  }

  return safe;
}

const REFERRAL_FLUSH_MS = 2500;
const flushTimers = new Map();

function formatReferralBatchBody(count, totalPoints) {
  if (count === 1) {
    return `تمت إضافة دعوة ناجحة (+${totalPoints} نقطة)`;
  }
  return `تمت إضافة ${count} دعوة ناجحة (+${totalPoints} نقطة)`;
}

async function flushReferralBatch(userId) {
  flushTimers.delete(String(userId));
  try {
    const buf = await ReferralBatchBuffer.findOneAndDelete({ user: userId });
    if (!buf || buf.count < 1) return null;

    const { count, totalPoints } = buf;
    const doc = await Notification.create({
      user: userId,
      type: "referral_batch",
      title: count === 1 ? "دعوة ناجحة!" : "دعوات ناجحة!",
      body: formatReferralBatchBody(count, totalPoints),
      data: enrichNotificationData("referral_batch", { count, totalPoints }),
    });
    invalidateNotificationCache(userId);
    dispatchPushAsync(doc);
    return doc;
  } catch (err) {
    safeLog("error", "notification_flush_referral_failed", { message: err.message, userId });
    return null;
  }
}

function scheduleReferralFlush(userId) {
  const key = String(userId);
  if (flushTimers.has(key)) clearTimeout(flushTimers.get(key));
  flushTimers.set(
    key,
    setTimeout(() => {
      flushReferralBatch(userId).catch(() => {});
    }, REFERRAL_FLUSH_MS)
  );
}

/**
 * تجميع مكافأة إحالة واحدة في buffer ثم إشعار موحّد بعد debounce.
 * 100 تسجيل متزامن → إشعار واحد: «تمت إضافة 100 دعوة ناجحة (+300 نقطة)»
 */
async function queueReferralReward({ user, pointsAdded }) {
  if (!user || !pointsAdded) return null;
  try {
    await ReferralBatchBuffer.findOneAndUpdate(
      { user },
      { $inc: { count: 1, totalPoints: pointsAdded } },
      { upsert: true, new: true }
    );
    scheduleReferralFlush(user);
    return true;
  } catch (err) {
    safeLog("error", "notification_queue_referral_failed", { message: err.message, userId: user });
    return null;
  }
}

/**
 * خدمة الإشعارات المركزية (AD-008/AD-009).
 * نقطة واحدة لإنشاء الإشعارات؛ يمكن لاحقاً توسيعها (بريد/واتساب/Push)
 * دون تغيير المستدعين.
 */

// إنشاء إشعار واحد. آمن: لا يرمي استثناءً يُسقط العملية المستدعية.
async function create({ user, type, title, body, data } = {}) {
  if (!user || !title) return null;
  const notifType = type || "general";
  try {
    const doc = await Notification.create({
      user,
      type: notifType,
      title,
      body: body || "",
      data: enrichNotificationData(notifType, data),
    });
    invalidateNotificationCache(user);
    dispatchPushAsync(doc);
    return doc;
  } catch (err) {
    safeLog("error", "notification_create_failed", { message: err.message, userId: user, type });
    return null;
  }
}

// إنشاء عدّة إشعارات (مستخدمون متعددون مثلاً).
async function createMany(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const docs = items
    .filter((i) => i && i.user && i.title)
    .map((i) => {
      const notifType = i.type || "general";
      return {
        user: i.user,
        type: notifType,
        title: i.title,
        body: i.body || "",
        data: enrichNotificationData(notifType, i.data),
      };
    });
  if (docs.length === 0) return [];
  try {
    const created = await Notification.insertMany(docs);
    const userIds = [...new Set(docs.map((d) => String(d.user)))];
    userIds.forEach(invalidateNotificationCache);
    created.forEach(dispatchPushAsync);
    return created;
  } catch (err) {
    safeLog("error", "notification_create_many_failed", { message: err.message, count: docs.length });
    return [];
  }
}

module.exports = { create, createMany, queueReferralReward, flushReferralBatch };

// است recovery: إذا توقف السيرفر أثناء التجميع، يُفرّغ buffer القديم
if (process.env.NODE_ENV !== "test") {
  setInterval(async () => {
    try {
      const stale = new Date(Date.now() - 8000);
      const buffers = await ReferralBatchBuffer.find({ updatedAt: { $lt: stale } })
        .select("user")
        .limit(20)
        .lean();
      if (!buffers.length) return;
      await Promise.all(buffers.map((b) => flushReferralBatch(b.user)));
    } catch (err) {
      safeLog("warn", "referral_buffer_sweep_failed", { message: err.message });
    }
  }, 12000);
}
