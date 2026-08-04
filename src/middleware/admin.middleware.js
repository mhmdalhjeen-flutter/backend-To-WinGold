const User = require("../models/user");
const {
  AUTH_USER_SELECT,
  isUserBlocked,
  blockedAuthMessage,
} = require("../utils/userSanitize.util");
const tokenService = require("../services/token.service");
const auditService = require("../services/audit.service");

module.exports = async (req, res, next) => {
  try {
    const token = tokenService.extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ message: "No token", code: "TOKEN_MISSING" });
    }

    const decoded = tokenService.verifyJwt(token);
    const user = await User.findById(decoded.id).select(AUTH_USER_SELECT);
    if (!user) {
      return res.status(401).json({ message: "User not found", code: "TOKEN_INVALID" });
    }

    if (user.role !== "admin") {
      auditService.logSecurityEvent(req, {
        action: "محاولة وصول إداري غير مصرح",
        details: `دور "${user.role}" حاول الوصول لمسار إداري`,
        severity: "warning",
        user,
        metadata: { path: req.originalUrl || req.path, method: req.method },
      }).catch(() => {});
      return res.status(403).json({ message: "Admins only" });
    }

    if (isUserBlocked(user)) {
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
    next();
  } catch (err) {
    return res.status(err.status || 401).json({
      message: err.message || "Invalid or expired token",
      code: err.code || "TOKEN_INVALID",
    });
  }
};
