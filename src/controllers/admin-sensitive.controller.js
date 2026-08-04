const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const SystemSetting = require("../models/systemSetting");
const auditService = require("../services/audit.service");
const { JWT_SIGN_OPTS, getJwtSecret } = require("../utils/jwtOptions.util");

const SENSITIVE_KEY = "platform_sensitive_password_hash";
const SENSITIVE_VERSION_KEY = "platform_sensitive_token_version";
const SENSITIVE_TTL = "30m";
const MIN_SENSITIVE_PASSWORD = 8;

async function getSensitiveTokenVersion() {
  const doc = await SystemSetting.findOne({ key: SENSITIVE_VERSION_KEY });
  const parsed = parseInt(doc?.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function bumpSensitiveTokenVersion() {
  const current = await getSensitiveTokenVersion();
  const next = current + 1;
  await SystemSetting.findOneAndUpdate(
    { key: SENSITIVE_VERSION_KEY },
    {
      key: SENSITIVE_VERSION_KEY,
      value: String(next),
      description: "إصدار توكن الصفحات الحساسة — يُرفع عند logout/تغيير كلمة المرور",
    },
    { upsert: true, new: true }
  );
  return next;
}

async function getHash() {
  const doc = await SystemSetting.findOne({ key: SENSITIVE_KEY });
  if (doc?.value) return doc.value;
  const legacyAdmin = await require("../models/user").findOne({
    role: "admin",
    sensitivePasswordHash: { $ne: null },
  }).select("sensitivePasswordHash");
  if (legacyAdmin?.sensitivePasswordHash) {
    await setHash(legacyAdmin.sensitivePasswordHash);
    return legacyAdmin.sensitivePasswordHash;
  }
  return null;
}

async function setHash(hash) {
  await SystemSetting.findOneAndUpdate(
    { key: SENSITIVE_KEY },
    { key: SENSITIVE_KEY, value: hash, description: "كلمة مرور الصفحات الحساسة للأدمن" },
    { upsert: true, new: true }
  );
}

exports.getStatus = async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    const hash = await getHash();
    res.json({ configured: !!hash });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.setupPassword = async (req, res) => {
  try {
    const body = req.body || {};
    const { password, confirmPassword } = body;
    if (!password || password.length < MIN_SENSITIVE_PASSWORD) {
      return res.status(400).json({ message: `كلمة المرور ${MIN_SENSITIVE_PASSWORD} أحرف على الأقل` });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ message: "كلمتا المرور غير متطابقتين" });
    }
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

    const existing = await getHash();
    if (existing) {
      return res.status(400).json({ message: "كلمة المرور مُعيَّنة — استخدم تغيير كلمة المرور" });
    }

    await setHash(await bcrypt.hash(password, 10));
    await bumpSensitiveTokenVersion();
    req.auditContext = {
      action: "تعيين كلمة مرور المناطق الحساسة",
      details: "تم تعيين كلمة مرور الصفحات المحمية للمرة الأولى",
      operationType: "create",
      entityType: "sensitive_password",
      page: "Sensitive Gate",
      severity: "warning",
    };
    res.json({ message: "تم تعيين كلمة المرور الإضافية للمنصة" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const body = req.body || {};
    const { currentPassword, newPassword, confirmPassword } = body;
    if (!newPassword || newPassword.length < MIN_SENSITIVE_PASSWORD) {
      return res.status(400).json({ message: `كلمة المرور الجديدة ${MIN_SENSITIVE_PASSWORD} أحرف على الأقل` });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "كلمتا المرور غير متطابقتين" });
    }

    const hash = await getHash();
    if (!hash) return res.status(400).json({ message: "لم تُعيَّن كلمة مرور بعد" });

    const ok = await bcrypt.compare(currentPassword || "", hash);
    if (!ok) {
      await auditService.logSecurityEvent(req, {
        action: "محاولة فاشلة لتغيير كلمة المرور الحساسة",
        details: "كلمة المرور الحالية غير صحيحة",
        severity: "warning",
        user: req.userDoc,
        metadata: { page: "Sensitive Gate" },
      });
      return res.status(401).json({ message: "كلمة المرور الحالية غير صحيحة" });
    }

    await setHash(await bcrypt.hash(newPassword, 10));
    await bumpSensitiveTokenVersion();
    req.auditContext = {
      action: "تغيير كلمة مرور المناطق الحساسة",
      details: "تم تحديث كلمة مرور الصفحات المحمية",
      operationType: "update",
      entityType: "sensitive_password",
      page: "Sensitive Gate",
      severity: "warning",
    };
    res.json({ message: "تم تحديث كلمة المرور" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.verifyPassword = async (req, res) => {
  try {
    const body = req.body || {};
    const { password } = body;
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });

    const hash = await getHash();
    if (!hash) {
      return res.status(400).json({ message: "يجب تعيين كلمة المرور أولاً", needsSetup: true });
    }

    const ok = await bcrypt.compare(password || "", hash);
    if (!ok) {
      await auditService.logSecurityEvent(req, {
        action: "محاولة فاشلة للوصول لصفحة محمية",
        details: "كلمة مرور المناطق الحساسة غير صحيحة",
        severity: "warning",
        user: req.userDoc,
        metadata: { page: "Sensitive Gate" },
      });
      return res.status(401).json({ message: "كلمة المرور غير صحيحة" });
    }

    const secret = getJwtSecret();

    const sv = await getSensitiveTokenVersion();
    const sensitiveToken = jwt.sign(
      { id: req.user.id, role: req.user.role, sensitive: true, platform: true, sv },
      secret,
      { expiresIn: SENSITIVE_TTL, ...JWT_SIGN_OPTS }
    );
    res.json({ sensitiveToken, expiresIn: SENSITIVE_TTL, message: "تم التحقق" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.revokeSensitiveSession = async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ message: "غير مصرح" });
    await bumpSensitiveTokenVersion();
    res.json({ message: "تم إبطال جلسة الصفحات الحساسة" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
