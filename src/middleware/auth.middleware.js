const User = require("../models/user");
const {
  AUTH_USER_SELECT,
  isUserBlocked,
  blockedAuthMessage,
} = require("../utils/userSanitize.util");
const tokenService = require("../services/token.service");
const authSessionCache = require("../utils/authSessionCache.util");
const { safeLog } = require("../utils/logSanitize.util");
const auditService = require("../services/audit.service");

const AUDIT_AUTH_CODES = new Set([
  "SESSION_INVALIDATED",
  "SESSION_ROLE_MISMATCH",
  "SESSION_DEVICE_MISMATCH",
  "SESSION_REVOKED",
  "ACCOUNT_BLOCKED",
]);

const authMiddleware = async (req, res, next) => {
  try {
    const token = tokenService.extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ message: "No token provided", code: "TOKEN_MISSING" });
    }

    const decoded = tokenService.verifyJwt(token);

    let user = await authSessionCache.get(decoded.id, decoded.tv);
    if (!user) {
      user = await User.findById(decoded.id).select(AUTH_USER_SELECT);
      if (user) {
        authSessionCache.set(decoded.id, user).catch(() => {});
      }
    }

    if (!user) {
      return res.status(401).json({ message: "User not found", code: "TOKEN_INVALID" });
    }

    if (isUserBlocked(user)) {
      auditService.logSecurityEvent(req, {
        action: "فشل المصادقة — حساب محظور",
        details: blockedAuthMessage(user.status),
        severity: "warning",
        user,
        metadata: { code: "ACCOUNT_BLOCKED", path: req.originalUrl },
      }).catch(() => {});
      return res.status(403).json({
        message: blockedAuthMessage(user.status),
        code: "ACCOUNT_BLOCKED",
      });
    }

    tokenService.validateAccessClaims(decoded, user, {
      deviceId: tokenService.extractDeviceId(req),
    });

    req.user = {
      id: user._id,
      role: user.role,
      email: user.email,
      deviceId: decoded.did || null,
    };
    req._authUserDoc = user;

    next();
  } catch (error) {
    safeLog("warn", "auth_token_rejected", {
      message: error.message,
      code: error.code,
      path: req.originalUrl,
    });

    if (AUDIT_AUTH_CODES.has(error.code)) {
      auditService.logSecurityEvent(req, {
        action: "فشل المصادقة",
        details: error.message,
        severity: "warning",
        metadata: { code: error.code, path: req.originalUrl },
      }).catch(() => {});
    }

    return res.status(error.status || 401).json({
      message: error.message || "Invalid or expired token",
      code: error.code || "TOKEN_INVALID",
    });
  }
};

module.exports = authMiddleware;
