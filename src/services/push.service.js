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

async function removeInvalidSubscription(endpoint) {
  if (!endpoint) return;
  try {
    await PushDevice.deleteOne({ "subscription.endpoint": endpoint });
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

  const body = JSON.stringify({
    title: payload.title || "",
    body: payload.body || "",
    data: payload.data || {},
  });

  try {
    await webpush.sendNotification(pushSubscription, body);
    return { ok: true };
  } catch (err) {
    const statusCode = err.statusCode || err.status;
    if (statusCode === 410 || statusCode === 404) {
      await removeInvalidSubscription(pushSubscription.endpoint);
      return { ok: false, gone: true, statusCode };
    }
    safeLog("warn", "push_send_failed", {
      statusCode,
      message: err.message,
    });
    return { ok: false, error: err.message, statusCode };
  }
}

/**
 * Fan out push to all registered Web Push devices for a user.
 */
async function sendPushToUser(userId, payload = {}) {
  if (!userId) return { sent: 0, failed: 0, skipped: 0 };

  if (!ensureVapidConfigured()) {
    return { sent: 0, failed: 0, skipped: 0, reason: "vapid_not_configured" };
  }

  const devices = await PushDevice.find({ userId }).select("subscription app").lean();
  if (!devices.length) return { sent: 0, failed: 0, skipped: 0 };

  let sent = 0;
  let failed = 0;

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
      if (result.ok) sent += 1;
      else failed += 1;
    })
  );

  return { sent, failed, skipped: 0 };
}

module.exports = {
  sendPushNotification,
  sendPushToUser,
  removeInvalidSubscription,
};
