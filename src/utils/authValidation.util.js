const { assertNoMongoOperators, cleanString } = require("./inputSecurity.util");

const OTP_CODE_PATTERN = /^\d{4,8}$/;

function cleanOtpCode(value, { field = "code", required = true } = {}) {
  const raw = cleanString(value, { field, max: 12, required });
  const digits = raw.replace(/\D/g, "");
  if (!OTP_CODE_PATTERN.test(digits)) {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  return digits;
}

function cleanAuthIdentifier(value) {
  return cleanString(value, { field: "identifier", max: 120, required: true });
}

function cleanAuthPassword(value, { min = 6, max = 128, field = "password" } = {}) {
  const password = cleanString(value, { field, max, required: true });
  if (password.length < min) {
    throw Object.assign(new Error(`كلمة المرور يجب أن تكون ${min} أحرف على الأقل`), { status: 400 });
  }
  return password;
}

function cleanVerificationChannel(value) {
  const channel = cleanString(value, { field: "channel", max: 10, required: true });
  if (!["email", "phone"].includes(channel)) {
    throw Object.assign(new Error("قناة التحقق غير صالحة"), { status: 400 });
  }
  return channel;
}

function cleanPromoCode(value) {
  return cleanString(value, { field: "code", max: 80, required: true }).toUpperCase();
}

function cleanAppType(value) {
  if (value == null || value === "") return undefined;
  const appType = cleanString(value, { field: "appType", max: 20 });
  if (!["customer", "business", "admin", "delivery"].includes(appType)) {
    throw Object.assign(new Error("appType غير صالح"), { status: 400 });
  }
  return appType;
}

function assertAuthBody(body, label = "auth") {
  assertNoMongoOperators(body, label);
}

module.exports = {
  cleanOtpCode,
  cleanAuthIdentifier,
  cleanAuthPassword,
  cleanVerificationChannel,
  cleanPromoCode,
  cleanAppType,
  assertAuthBody,
};
