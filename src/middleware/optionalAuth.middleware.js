const User = require("../models/user");
const { isUserBlocked } = require("../utils/userSanitize.util");
const tokenService = require("../services/token.service");

/** يملأ req.user إن وُجد توكن صالح — لا يرفض الطلب بدونه. */
module.exports = async function optionalAuth(req, res, next) {
  const token = tokenService.extractBearerToken(req);
  if (!token) return next();

  try {
    const decoded = tokenService.verifyJwt(token);
    const user = await User.findById(decoded.id).select("role status tokenVersion sessions").lean();
    if (!user || isUserBlocked(user)) return next();

    tokenService.validateAccessClaims(decoded, user, {
      deviceId: tokenService.extractDeviceId(req),
    });

    req.user = { id: user._id, role: user.role, deviceId: decoded.did || null };
  } catch {
    /* تجاهل توكن منتهٍ أو غير صالح */
  }

  next();
};
