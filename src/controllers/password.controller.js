const bcrypt = require("bcryptjs");
const User = require("../models/user");
const SystemSetting = require("../models/systemSetting");
const auditService = require("../services/audit.service");
const { generateVerifyCode, hashVerificationSecret, verifyVerificationSecret } = require("../utils/verification.util");
const verificationService = require("../services/verification.service");
const {
  normalizeLocalPhone,
  isValidLocalPhone,
  LOCAL_PHONE_MESSAGE,
} = require("../utils/phone.util");

const MIN_PASSWORD = 6;
const MIN_ADMIN_PASSWORD = 8;
const RESET_TTL_MS = 10 * 60 * 1000;
const tokenService = require("../services/token.service");
const { isCustomerExperienceRole } = require("../constants/customerExperience.constants");
const {
  assertAuthBody,
  cleanAuthIdentifier,
  cleanAuthPassword,
  cleanAppType,
  cleanOtpCode,
} = require("../utils/authValidation.util");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

async function bumpSensitiveTokenVersion() {
  return tokenService.bumpSensitiveTokenVersion();
}

async function invalidateUserSessions(user, { revokeSensitive = false } = {}) {
  await tokenService.invalidateAllUserTokens(user, { revokeSensitive });
}

function validatePasswordPair(newPassword, confirmPassword, minLen = MIN_PASSWORD) {
  if (!newPassword) return "كلمة المرور الجديدة مطلوبة";
  if (newPassword.length < minLen) {
    return `كلمة المرور يجب أن تكون ${minLen} أحرف على الأقل`;
  }
  if (newPassword !== confirmPassword) return "كلمة المرور غير متطابقة";
  return null;
}

function resolveIdentifier(identifier) {
  const clean = identifier?.trim();
  if (!clean) return null;
  const isEmail = clean.includes("@");
  return {
    isEmail,
    email: isEmail ? clean.toLowerCase() : undefined,
    phone: !isEmail ? normalizeLocalPhone(clean) : undefined,
  };
}

async function findUserByIdentifier(identifier) {
  const parsed = resolveIdentifier(identifier);
  if (!parsed) return null;
  if (parsed.phone && !isValidLocalPhone(parsed.phone)) return null;
  return User.findOne({
    $or: [
      parsed.email ? { email: parsed.email } : null,
      parsed.phone ? { phone: parsed.phone } : null,
    ].filter(Boolean),
  });
}

function assertRoleForApp(user, appType) {
  if (!appType) return null;
  if (appType === "customer" && !isCustomerExperienceRole(user.role)) {
    return "هذا الحساب غير مخصص لتطبيق الزبائن";
  }
  if (appType === "business" && !["store", "supplier"].includes(user.role)) {
    return "هذا الحساب غير مخصص لتطبيق التجار";
  }
  if (appType === "admin" && user.role !== "admin") {
    return "غير مصرح بالدخول";
  }
  return null;
}

exports.changePassword = async (req, res) => {
  try {
    assertAuthBody(req.body, "password");
    const currentPassword = cleanAuthPassword(req.body.currentPassword, { min: 1, field: "currentPassword" });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const minLen = user.role === "admin" ? MIN_ADMIN_PASSWORD : MIN_PASSWORD;
    const newPassword = cleanAuthPassword(req.body.newPassword, { min: minLen, max: 128, field: "newPassword" });
    const confirmPassword = cleanAuthPassword(req.body.confirmPassword, { min: minLen, max: 128, field: "confirmPassword" });
    const pairErr = validatePasswordPair(newPassword, confirmPassword, minLen);
    if (pairErr) return res.status(400).json({ message: pairErr });

    if (!user.password) {
      return res.status(400).json({
        message: "هذا الحساب لا يستخدم كلمة مرور — استخدم «نسيت كلمة المرور» لتعيين واحدة",
      });
    }

    const ok = await bcrypt.compare(currentPassword || "", user.password);
    if (!ok) {
      if (user.role === "admin") {
        await auditService.logSecurityEvent(req, {
          action: "محاولة فاشلة لتغيير كلمة مرور الأدمن",
          details: "كلمة المرور الحالية غير صحيحة",
          severity: "warning",
          user,
          metadata: { page: "Account Settings" },
        });
      }
      return res.status(400).json({ message: "كلمة المرور الحالية غير صحيحة" });
    }

    if (await bcrypt.compare(newPassword, user.password)) {
      return res.status(400).json({ message: "كلمة المرور الجديدة يجب أن تختلف عن الحالية" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await invalidateUserSessions(user, { revokeSensitive: user.role === "admin" });

    if (user.role === "admin") {
      await auditService.logAdminAction(req, {
        action: "تغيير كلمة مرور الأدمن",
        details: `تم تغيير كلمة مرور حساب ${user.email || user.name}`,
        operationType: "update",
        entityType: "admin_account",
        entityId: user._id,
        entityName: user.name || user.email,
        page: "Account Settings",
        severity: "warning",
      });
    }

    return res.json({ message: "تم تغيير كلمة المرور بنجاح" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.forgotPasswordRequest = async (req, res) => {
  try {
    assertAuthBody(req.body, "password");
    const identifier = cleanAuthIdentifier(req.body.identifier);
    const appType = cleanAppType(req.body.appType);

    const parsed = resolveIdentifier(identifier);
    if (!parsed) return res.status(400).json({ message: "بيانات غير صالحة" });
    if (parsed.phone && !isValidLocalPhone(parsed.phone)) {
      return res.status(400).json({ message: LOCAL_PHONE_MESSAGE });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({ message: "لم يُعثر على حساب بهذه البيانات" });
    }

    const roleErr = assertRoleForApp(user, appType);
    if (roleErr) return res.status(403).json({ message: roleErr });

    if (!user.email && !user.phone) {
      return res.status(400).json({ message: "لا يوجد بريد أو هاتف مرتبط بهذا الحساب" });
    }

    const code = generateVerifyCode();
    user.passwordResetCode = hashVerificationSecret(code);
    user.passwordResetExpires = new Date(Date.now() + RESET_TTL_MS);
    await user.save();

    const sentToEmail = parsed.isEmail && user.email;
    const channel = sentToEmail ? "email" : "phone";
    try {
      await verificationService.sendPasswordResetOtp({ user, channel, code });
    } catch (sendErr) {
      user.passwordResetCode = null;
      user.passwordResetExpires = null;
      await user.save();
      return res.status(503).json({ message: sendErr.message || "تعذّر إرسال رمز التحقق" });
    }

    const payload = {
      message: sentToEmail
        ? "تم إرسال رمز التحقق إلى بريدك الإلكتروني"
        : "تم إرسال رمز التحقق عبر SMS إلى هاتفك",
      channel,
    };
    return res.json(payload);
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

exports.forgotPasswordReset = async (req, res) => {
  try {
    assertAuthBody(req.body, "password");
    const identifier = cleanAuthIdentifier(req.body.identifier);
    const code = cleanOtpCode(req.body.code);
    const appType = cleanAppType(req.body.appType);

    const user = await findUserByIdentifier(identifier);
    if (!user) return res.status(404).json({ message: "لم يُعثر على حساب" });

    const roleErr = assertRoleForApp(user, appType);
    if (roleErr) return res.status(403).json({ message: roleErr });

    if (!user.passwordResetCode || !user.passwordResetExpires) {
      return res.status(400).json({ message: "لا يوجد طلب إعادة تعيين نشط — اطلب رمزاً جديداً" });
    }
    if (user.passwordResetExpires < new Date()) {
      return res.status(400).json({ message: "انتهت صلاحية الرمز — أعد الطلب" });
    }
    if (!verifyVerificationSecret(String(code).trim(), user.passwordResetCode)) {
      return res.status(400).json({ message: "رمز التحقق غير صحيح" });
    }

    const minLen = user.role === "admin" ? MIN_ADMIN_PASSWORD : MIN_PASSWORD;
    const newPassword = cleanAuthPassword(req.body.newPassword, { min: minLen, max: 128, field: "newPassword" });
    const confirmPassword = cleanAuthPassword(req.body.confirmPassword, { min: minLen, max: 128, field: "confirmPassword" });
    const pairErr = validatePasswordPair(newPassword, confirmPassword, minLen);
    if (pairErr) return res.status(400).json({ message: pairErr });

    user.password = await bcrypt.hash(newPassword, 10);
    await invalidateUserSessions(user, { revokeSensitive: user.role === "admin" });
    user.passwordResetCode = null;
    user.passwordResetExpires = null;

    return res.json({ message: "تم تعيين كلمة المرور بنجاح — يمكنك تسجيل الدخول الآن" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
