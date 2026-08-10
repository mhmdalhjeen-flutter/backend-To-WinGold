const webpush = require("web-push");
const PushDevice = require("../models/pushDevice");
const { configureVapid, isVapidConfigured } = require("../config/vapid");
const { safeLog } = require("../utils/logSanitize.util");

let vapidInitialized = false;

function ensureVapidConfigured() {
  if (vapidInitialized) return isVapidConfigured();
  configureVapid();
  vapidInitialized = true;
  return isVapidConfigured();
}

function normalizeSubscription(subscription) {
  if (!subscription?.endpoint) return null;
  const keys = subscription.keys || {};
  if (!keys.p256dh || !keys.auth) return null;
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}

function endpointHost(endpoint) {
  if (!endpoint || typeof endpoint !== "string") return "";
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}

function buildPushBody(payload = {}) {
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : {};
  return JSON.stringify({
    title: payload.title || "",
    body: payload.body || "",
    icon: payload.icon || "",
    url: payload.url || data.url || "",
    type: payload.type || data.type || "",
    notificationId: payload.notificationId || data.notificationId || "",
    data,
  });
}

async function removeInvalidSubscription(endpoint) {
  if (!endpoint) return;
  try {
    const result = await PushDevice.deleteOne({ "subscription.endpoint": endpoint });
    safeLog("info", "push_subscription_removed", {
      endpointHost: endpointHost(endpoint),
      removed: result.deletedCount > 0,
    });
  } catch (err) {
    safeLog("warn", "push_remove_subscription_failed", { message: err.message });
  }
}

/**
 * Send a Web Push payload to one browser subscription object.
 * Removes stored subscription when the push service returns 410 Gone.
 */
async function sendPushNotification(subscription, payload = {}) {
  if (!ensureVapidConfigured()) {
    return { ok: false, skipped: true, reason: "vapid_not_configured" };
  }

  const pushSubscription = normalizeSubscription(subscription);
  if (!pushSubscription) {
    return { ok: false, error: "invalid_subscription" };
  }

  const body = buildPushBody(payload);

  try {
    await webpush.sendNotification(pushSubscription, body);
    safeLog("info", "push_send_ok", {
      endpointHost: endpointHost(pushSubscription.endpoint),
      type: payload.type || payload.data?.type || "general",
    });
    return { ok: true };
  } catch (err) {
    const statusCode = err.statusCode || err.status;
    if (statusCode === 410 || statusCode === 404) {
      await removeInvalidSubscription(pushSubscription.endpoint);
      safeLog("warn", "push_subscription_expired", {
        endpointHost: endpointHost(pushSubscription.endpoint),
        statusCode,
      });
      return { ok: false, gone: true, statusCode, reason: "subscription_expired" };
    }
    safeLog("warn", "push_send_failed", {
      statusCode,
      message: err.message,
      endpointHost: endpointHost(pushSubscription.endpoint),
    });
    return { ok: false, error: err.message, statusCode, reason: "provider_rejected" };
  }
}

/**
 * Fan out push to registered Web Push devices for a user.
 * @param {string|ObjectId} userId
 * @param {object} payload
 * @param {{ app?: 'customer'|'store'|'admin'|'delivery', platform?: 'web' }} [options]
 */
async function sendPushToUser(userId, payload = {}, options = {}) {
  const empty = { sent: 0, failed: 0, skipped: 0, devices: 0 };

  if (!userId) return { ...empty, reason: "missing_user" };

  if (!ensureVapidConfigured()) {
    safeLog("warn", "push_skipped_vapid", { userId: String(userId) });
    return { ...empty, reason: "vapid_not_configured" };
  }

  const filter = { userId };
  if (options.app) filter.app = options.app;
  if (options.platform) filter.platform = options.platform;

  const devices = await PushDevice.find(filter).select("subscription app platform").lean();
  if (!devices.length) {
    safeLog("info", "push_no_subscriptions", {
      userId: String(userId),
      app: options.app || "any",
      platform: options.platform || "any",
    });
    return { ...empty, reason: "no_subscription" };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  await Promise.all(
    devices.map(async (device) => {
      const devicePayload = {
        ...payload,
        data: {
          ...(payload.data || {}),
          app: device.app,
        },
      };
      const result = await sendPushNotification(device.subscription, devicePayload);
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        if (result.reason || result.error) {
          errors.push(result.reason || result.error);
        }
      }
    })
  );

  return {
    sent,
    failed,
    skipped: 0,
    devices: devices.length,
    reason: sent > 0 ? "sent" : errors[0] || "failed",
  };
}

/**
 * Send a test push to the authenticated user's registered devices.
 */
async function sendTestPush(userId, options = {}) {
  const { VALID_PUSH_APPS, resolvePushUrl } = require("../utils/pushTarget.util");
  const app = VALID_PUSH_APPS.has(options.app) ? options.app : "customer";
  const url = resolvePushUrl(app, "push_test", {});
  const payload = {
    title: options.title || "Win Gold — اختبار الإشعارات",
    body: options.body || "إذا ظهر هذا الإشعار، فإن Web Push يعمل على جهازك.",
    icon: "/brand/logo-192.webp",
    url,
    type: "push_test",
    notificationId: `test-${Date.now()}`,
    data: {
      type: "push_test",
      url,
      pushApp: app,
    },
  };

  return sendPushToUser(userId, payload, { app, platform: "web" });
}

function getPushDiagnostics() {
  return {
    vapidConfigured: isVapidConfigured(),
    vapidPublicKeyPresent: Boolean(process.env.VAPID_PUBLIC_KEY?.trim()),
    vapidPrivateKeyPresent: Boolean(process.env.VAPID_PRIVATE_KEY?.trim()),
    vapidSubjectPresent: Boolean(process.env.VAPID_SUBJECT?.trim()),
  };
}

module.exports = {
  sendPushNotification,
  sendPushToUser,
  sendTestPush,
  removeInvalidSubscription,
  getPushDiagnostics,
  ensureVapidConfigured,
};
