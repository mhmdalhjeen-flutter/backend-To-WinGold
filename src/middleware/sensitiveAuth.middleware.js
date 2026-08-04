const tokenService = require("../services/token.service");
const SystemSetting = require("../models/systemSetting");

const SENSITIVE_VERSION_KEY = "platform_sensitive_token_version";

async function getSensitiveTokenVersion() {
  const doc = await SystemSetting.findOne({ key: SENSITIVE_VERSION_KEY });
  const parsed = parseInt(doc?.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** يتطلّب JWT عادي + توكن حساس (x-sensitive-token). */
module.exports = async function sensitiveAuthMiddleware(req, res, next) {
  const token = req.headers["x-sensitive-token"];
  if (!token) {
    return res.status(403).json({ message: "مطلوب التحقق الإضافي للصفحات الحساسة", sensitiveRequired: true });
  }
  try {
    const payload = tokenService.verifyJwt(token);
    if (!payload.sensitive || payload.role !== "admin") {
      return res.status(403).json({ message: "توكن غير صالح", code: "SENSITIVE_INVALID" });
    }
    if (String(payload.id) !== String(req.user.id)) {
      return res.status(403).json({ message: "توكن لا يطابق المستخدم", code: "SENSITIVE_USER_MISMATCH" });
    }
    const currentVersion = await getSensitiveTokenVersion();
    if (payload.sv == null || Number(payload.sv) !== currentVersion) {
      return res.status(403).json({
        message: "انتهت صلاحية التحقق — أدخل كلمة المرور مجدداً",
        sensitiveExpired: true,
        code: "SENSITIVE_REVOKED",
      });
    }
    next();
  } catch (error) {
    return res.status(403).json({
      message: "انتهت صلاحية التحقق — أدخل كلمة المرور مجدداً",
      sensitiveExpired: true,
      code: error.code || "SENSITIVE_INVALID",
    });
  }
};
