const User = require("../models/user");
const platformSettings = require("../services/platformSettings.service");
const tokenService = require("../services/token.service");

function normalizePath(url = "") {
  return url.split("?")[0];
}

function isWhitelisted(path, method) {
  if (path.startsWith("/api/admin")) return true;
  if (path === "/api/settings/public" && method === "GET") return true;
  if (path === "/api/auth/login" && method === "POST") return true;
  if (path === "/api/v1/health" && method === "GET") return true;
  if (path === "/api/v1/" && method === "GET") return true;
  return false;
}

async function getDbRole(req) {
  const token = tokenService.extractBearerToken(req);
  if (!token) return null;
  try {
    const decoded = tokenService.verifyJwt(token);
    const user = await User.findById(decoded.id).select("role tokenVersion sessions").lean();
    if (!user) return null;
    tokenService.validateAccessClaims(decoded, user, {
      deviceId: tokenService.extractDeviceId(req),
    });
    return user.role;
  } catch {
    return null;
  }
}

let maintenanceCache = { at: 0, enabled: false, message: "" };
const CACHE_MS = 10_000;

/**
 * يوقف كل واجهات API للزبائن والتجار أثناء الصيانة.
 * الأدمن (role=admin) ومسارات الأدمن و /settings/public مستثناة.
 */
async function maintenanceMiddleware(req, res, next) {
  try {
    const path = normalizePath(req.originalUrl);
    if (isWhitelisted(path, req.method)) return next();

    const now = Date.now();
    let enabled;
    let message;

    if (now - maintenanceCache.at < CACHE_MS) {
      enabled = maintenanceCache.enabled;
      message = maintenanceCache.message;
    } else {
      const info = await platformSettings.getMaintenanceInfo();
      enabled = info.enabled;
      message = info.message;
      maintenanceCache = { at: now, enabled, message };
    }

    if (!enabled) return next();

    const role = await getDbRole(req);
    if (role === "admin") return next();

    return res.status(503).json({
      message,
      code: "MAINTENANCE_MODE",
      maintenanceMode: true,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = maintenanceMiddleware;
