const { toE164ForTwilio } = require("../utils/phone.util");
const { maskIdentifier, safeLog } = require("../utils/logSanitize.util");

function isSmsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
}

/** @deprecated use toE164ForTwilio from phone.util */
const toE164Palestine = toE164ForTwilio;

async function sendSms({ to, body }) {
  if (!to || !body) throw new Error("رقم الهاتف والرسالة مطلوبان");

  const destination = toE164Palestine(to);

  if (!isSmsConfigured()) {
    safeLog("warn", "sms_skipped_not_configured", { to: maskIdentifier(destination) });
    return { sent: false, skipped: true, reason: "SMS_NOT_CONFIGURED" };
  }

  const twilio = require("twilio")(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  await twilio.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: destination,
  });

  return { sent: true };
}

async function sendVerificationSms({ phone, code }) {
  const appName = process.env.APP_NAME || "Offers Tech";
  return sendSms({
    to: phone,
    body: `${appName}: رمز التوثيق ${code}. صالح 10 دقائق. لا تشاركه مع أحد.`,
  });
}

async function sendPasswordResetSms({ phone, code }) {
  const appName = process.env.APP_NAME || "Offers Tech";
  return sendSms({
    to: phone,
    body: `${appName}: رمز إعادة تعيين كلمة المرور ${code}. صالح 10 دقائق.`,
  });
}

module.exports = {
  isSmsConfigured,
  toE164Palestine,
  sendSms,
  sendVerificationSms,
  sendPasswordResetSms,
};
