const crypto = require("crypto");
const emailService = require("./email.service");
const smsService = require("./sms.service");
const {
  VERIFICATION_CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  generateVerifyCode,
  generateLinkToken,
  hashVerificationSecret,
  verifyVerificationSecret,
  syncVerifiedFlag,
  awardVerificationBonus,
  isUserVerified,
} = require("../utils/verification.util");

const lastSentAt = new Map();

function sentKey(userId, channel) {
  return `${userId}:${channel}`;
}

function assertResendCooldown(userId, channel) {
  const key = sentKey(userId, channel);
  const last = lastSentAt.get(key);
  if (last && Date.now() - last < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last)) / 1000);
    const err = new Error(`يرجى الانتظار ${waitSec} ثانية قبل إعادة الإرسال`);
    err.status = 429;
    throw err;
  }
}

function markSent(userId, channel) {
  lastSentAt.set(sentKey(userId, channel), Date.now());
}

function getCustomerAppUrl() {
  return (process.env.CUSTOMER_APP_URL || "http://localhost:5173").replace(/\/$/, "");
}

function buildEmailVerifyLink(userId, token) {
  return `${getCustomerAppUrl()}/verify-email?token=${encodeURIComponent(token)}&uid=${encodeURIComponent(userId)}`;
}

async function sendEmailVerification(user) {
  if (!user.email) {
    const err = new Error("لا يوجد بريد مرتبط بالحساب");
    err.status = 400;
    throw err;
  }
  if (user.emailVerified) {
    const err = new Error("البريد موثّق مسبقاً");
    err.status = 400;
    throw err;
  }
  if (!emailService.isEmailConfigured()) {
    const err = new Error("التوثيق عبر البريد غير متاح حالياً — يمكنك استخدام المنصة بدون توثيق");
    err.status = 503;
    err.code = "EMAIL_DELIVERY_UNAVAILABLE";
    throw err;
  }

  assertResendCooldown(user._id, "email");

  const code = generateVerifyCode();
  const linkToken = generateLinkToken();

  user.verifyEmailCode = hashVerificationSecret(code);
  user.verifyEmailLinkToken = hashVerificationSecret(linkToken);
  user.verifyEmailExpires = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
  await user.save();

  const verifyLink = buildEmailVerifyLink(String(user._id), linkToken);
  const delivery = await emailService.sendVerificationEmail({
    to: user.email,
    name: user.name,
    code,
    verifyLink,
  });

  if (delivery.skipped) {
    user.verifyEmailCode = null;
    user.verifyEmailLinkToken = null;
    user.verifyEmailExpires = null;
    await user.save();
    const err = new Error("التوثيق عبر البريد غير متاح حالياً — يمكنك استخدام المنصة بدون توثيق");
    err.status = 503;
    err.code = "EMAIL_DELIVERY_UNAVAILABLE";
    throw err;
  }

  markSent(user._id, "email");

  return { message: "تم إرسال رمز التحقق إلى بريدك الإلكتروني — تحقق من صندوق الوارد ومجلد Spam" };
}

async function sendPhoneVerification(user) {
  if (!user.phone) {
    const err = new Error("لا يوجد هاتف مرتبط بالحساب");
    err.status = 400;
    throw err;
  }
  if (user.phoneVerified) {
    const err = new Error("الهاتف موثّق مسبقاً");
    err.status = 400;
    throw err;
  }
  if (!smsService.isSmsConfigured()) {
    const err = new Error("التوثيق عبر SMS غير متاح حالياً — يمكنك استخدام المنصة بدون توثيق");
    err.status = 503;
    err.code = "SMS_DELIVERY_UNAVAILABLE";
    throw err;
  }

  assertResendCooldown(user._id, "phone");

  const code = generateVerifyCode();
  user.verifyPhoneCode = hashVerificationSecret(code);
  user.verifyPhoneExpires = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
  await user.save();

  const delivery = await smsService.sendVerificationSms({ phone: user.phone, code });
  if (delivery.skipped) {
    user.verifyPhoneCode = null;
    user.verifyPhoneExpires = null;
    await user.save();
    const err = new Error("التوثيق عبر SMS غير متاح حالياً — يمكنك استخدام المنصة بدون توثيق");
    err.status = 503;
    err.code = "SMS_DELIVERY_UNAVAILABLE";
    throw err;
  }

  markSent(user._id, "phone");

  return { message: "تم إرسال رمز التحقق عبر SMS إلى هاتفك" };
}

function clearEmailVerificationFields(user) {
  user.emailVerified = true;
  user.verifyEmailCode = null;
  user.verifyEmailLinkToken = null;
  user.verifyEmailExpires = null;
}

function clearPhoneVerificationFields(user) {
  user.phoneVerified = true;
  user.verifyPhoneCode = null;
  user.verifyPhoneExpires = null;
}

async function confirmEmailCode(user, code) {
  if (!user.verifyEmailCode || !user.verifyEmailExpires) {
    const err = new Error("لا يوجد طلب تحقق نشط");
    err.status = 400;
    throw err;
  }
  if (user.verifyEmailExpires < new Date()) {
    const err = new Error("انتهت صلاحية الرمز — أعد الطلب");
    err.status = 400;
    throw err;
  }
  if (!verifyVerificationSecret(String(code).trim(), user.verifyEmailCode)) {
    const err = new Error("رمز التحقق غير صحيح");
    err.status = 400;
    throw err;
  }
  clearEmailVerificationFields(user);
}

async function confirmEmailLink(userId, token) {
  const User = require("../models/user");
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("المستخدم غير موجود");
    err.status = 404;
    throw err;
  }
  if (user.emailVerified) {
    return { alreadyVerified: true, user };
  }
  if (!user.verifyEmailLinkToken || !user.verifyEmailExpires) {
    const err = new Error("رابط التفعيل غير صالح أو منتهٍ");
    err.status = 400;
    throw err;
  }
  if (user.verifyEmailExpires < new Date()) {
    const err = new Error("انتهت صلاحية رابط التفعيل — اطلب رمزاً جديداً");
    err.status = 400;
    throw err;
  }
  if (!verifyVerificationSecret(String(token).trim(), user.verifyEmailLinkToken)) {
    const err = new Error("رابط التفعيل غير صالح");
    err.status = 400;
    throw err;
  }
  clearEmailVerificationFields(user);
  return { user };
}

async function confirmPhoneCode(user, code) {
  if (!user.verifyPhoneCode || !user.verifyPhoneExpires) {
    const err = new Error("لا يوجد طلب تحقق نشط");
    err.status = 400;
    throw err;
  }
  if (user.verifyPhoneExpires < new Date()) {
    const err = new Error("انتهت صلاحية الرمز — أعد الطلب");
    err.status = 400;
    throw err;
  }
  if (!verifyVerificationSecret(String(code).trim(), user.verifyPhoneCode)) {
    const err = new Error("رمز التحقق غير صحيح");
    err.status = 400;
    throw err;
  }
  clearPhoneVerificationFields(user);
}

async function finalizeVerification(user) {
  syncVerifiedFlag(user);
  const bonusPoints = await awardVerificationBonus(user);
  return bonusPoints;
}

async function sendPhoneChangeOtp(user, phone, code) {
  if (!smsService.isSmsConfigured()) {
    const err = new Error("تغيير الهاتف عبر SMS غير متاح حالياً");
    err.status = 503;
    err.code = "SMS_DELIVERY_UNAVAILABLE";
    throw err;
  }
  assertResendCooldown(user._id, "phone_change");
  const delivery = await smsService.sendVerificationSms({ phone, code });
  if (delivery.skipped) {
    const err = new Error("تغيير الهاتف عبر SMS غير متاح حالياً");
    err.status = 503;
    err.code = "SMS_DELIVERY_UNAVAILABLE";
    throw err;
  }
  markSent(user._id, "phone_change");
  return delivery;
}

async function sendPasswordResetOtp({ user, channel, code }) {
  if (channel === "email") {
    if (!user.email) throw new Error("لا يوجد بريد مرتبط");
    if (!emailService.isEmailConfigured()) {
      const err = new Error("إعادة تعيين كلمة المرور عبر البريد غير متاحة حالياً");
      err.status = 503;
      err.code = "EMAIL_DELIVERY_UNAVAILABLE";
      throw err;
    }
    const delivery = await emailService.sendPasswordResetEmail({ to: user.email, name: user.name, code });
    if (delivery.skipped) {
      const err = new Error("إعادة تعيين كلمة المرور عبر البريد غير متاحة حالياً");
      err.status = 503;
      err.code = "EMAIL_DELIVERY_UNAVAILABLE";
      throw err;
    }
    return delivery;
  }
  if (channel === "phone") {
    if (!user.phone) throw new Error("لا يوجد هاتف مرتبط");
    if (!smsService.isSmsConfigured()) {
      const err = new Error("إعادة تعيين كلمة المرور عبر SMS غير متاحة حالياً");
      err.status = 503;
      err.code = "SMS_DELIVERY_UNAVAILABLE";
      throw err;
    }
    const delivery = await smsService.sendPasswordResetSms({ phone: user.phone, code });
    if (delivery.skipped) {
      const err = new Error("إعادة تعيين كلمة المرور عبر SMS غير متاحة حالياً");
      err.status = 503;
      err.code = "SMS_DELIVERY_UNAVAILABLE";
      throw err;
    }
    return delivery;
  }
  throw new Error("قناة غير مدعومة");
}

module.exports = {
  sendEmailVerification,
  sendPhoneVerification,
  confirmEmailCode,
  confirmEmailLink,
  confirmPhoneCode,
  finalizeVerification,
  sendPhoneChangeOtp,
  sendPasswordResetOtp,
  hashVerificationSecret,
  verifyVerificationSecret,
  isUserVerified,
};
