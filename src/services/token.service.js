const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const SystemSetting = require("../models/systemSetting");
const authSessionCache = require("../utils/authSessionCache.util");
const {
  JWT_VERIFY_OPTS,
  JWT_SIGN_OPTS,
  JWT_EXPIRES_DEFAULT,
  JWT_EXPIRES_ADMIN,
  JWT_REFRESH_EXPIRES_DEFAULT,
  JWT_REFRESH_EXPIRES_ADMIN,
  MAX_ACTIVE_SESSIONS,
  getJwtSecret,
} = require("../utils/jwtOptions.util");

const SENSITIVE_VERSION_KEY = "platform_sensitive_token_version";
const REFRESH_TOKEN_TYPE = "refresh";

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function generateDeviceId() {
  return crypto.randomUUID();
}

function authError(message, code, status = 401) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function getAccessExpiresIn(role) {
  return role === "admin" ? JWT_EXPIRES_ADMIN : JWT_EXPIRES_DEFAULT;
}

function getRefreshExpiresIn(role) {
  return role === "admin" ? JWT_REFRESH_EXPIRES_ADMIN : JWT_REFRESH_EXPIRES_DEFAULT;
}

function normalizeUserId(user) {
  return user?._id ?? user?.id;
}

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

/**
 * Verify JWT signature + expiration (via jsonwebtoken).
 * Returns decoded payload or throws authError with specific code.
 */
function verifyJwt(token) {
  if (!token || typeof token !== "string") {
    throw authError("Token missing", "TOKEN_MISSING");
  }

  try {
    return jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTS);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw authError("Token expired", "TOKEN_EXPIRED");
    }
    if (error.name === "JsonWebTokenError") {
      throw authError("Invalid token signature", "TOKEN_INVALID");
    }
    throw authError("Invalid or expired token", "TOKEN_INVALID");
  }
}

/**
 * Full access-token validation against DB user:
 * - signature + exp (via verifyJwt)
 * - session version (tv)
 * - role binding
 * - optional deviceId binding
 */
function validateAccessClaims(decoded, user, { deviceId } = {}) {
  if (!decoded?.id) {
    throw authError("Invalid token payload", "TOKEN_INVALID");
  }

  if (String(decoded.id) !== String(normalizeUserId(user))) {
    throw authError("Token user mismatch", "TOKEN_INVALID");
  }

  const tokenVersion = decoded.tv ?? 0;
  const userVersion = user.tokenVersion ?? 0;
  if (tokenVersion !== userVersion) {
    throw authError("Session expired — please login again", "SESSION_INVALIDATED");
  }

  if (decoded.role && decoded.role !== user.role) {
    throw authError("Session role mismatch — please login again", "SESSION_ROLE_MISMATCH");
  }

  if (decoded.did) {
    const headerDeviceId = deviceId?.trim();
    if (headerDeviceId && decoded.did !== headerDeviceId) {
      throw authError("Session device mismatch", "SESSION_DEVICE_MISMATCH");
    }

    const sessions = user.sessions || [];
    if (sessions.length > 0 && !sessions.some((s) => s.deviceId === decoded.did)) {
      throw authError("Session revoked — please login again", "SESSION_REVOKED");
    }
  }

  return decoded;
}

function validateRefreshClaims(decoded, user, refreshTokenRaw) {
  if (decoded?.type !== REFRESH_TOKEN_TYPE) {
    throw authError("Invalid refresh token", "REFRESH_INVALID");
  }

  if (String(decoded.id) !== String(normalizeUserId(user))) {
    throw authError("Invalid refresh token", "REFRESH_INVALID");
  }

  const tokenVersion = decoded.rv ?? 0;
  const userVersion = user.refreshTokenVersion ?? 0;
  if (tokenVersion !== userVersion) {
    throw authError("Refresh token revoked", "REFRESH_REVOKED");
  }

  const deviceId = decoded.did;
  if (!deviceId) {
    throw authError("Invalid refresh token", "REFRESH_INVALID");
  }

  const session = (user.sessions || []).find((s) => s.deviceId === deviceId);
  if (!session) {
    throw authError("Refresh session not found", "REFRESH_REVOKED");
  }

  if (session.refreshTokenHash !== hashToken(refreshTokenRaw)) {
    throw authError("Refresh token reuse detected", "REFRESH_REUSE");
  }

  return { deviceId, session };
}

function signAccessToken(user, { deviceId } = {}) {
  const did = deviceId || generateDeviceId();
  const userId = normalizeUserId(user);
  const token = jwt.sign(
    {
      id: userId,
      role: user.role,
      tv: user.tokenVersion ?? 0,
      did,
    },
    getJwtSecret(),
    { expiresIn: getAccessExpiresIn(user.role), ...JWT_SIGN_OPTS }
  );

  return { accessToken: token, deviceId: did };
}

function signRefreshToken(user, { deviceId }) {
  const userId = normalizeUserId(user);
  const refreshToken = jwt.sign(
    {
      id: userId,
      rv: user.refreshTokenVersion ?? 0,
      did: deviceId,
      type: REFRESH_TOKEN_TYPE,
    },
    getJwtSecret(),
    { expiresIn: getRefreshExpiresIn(user.role), ...JWT_SIGN_OPTS }
  );

  return {
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
  };
}

async function upsertSession(user, deviceId, refreshTokenHash) {
  const now = new Date();
  const sessions = (user.sessions || []).filter((s) => s.deviceId !== deviceId);
  sessions.push({
    deviceId,
    refreshTokenHash,
    createdAt: now,
    lastUsedAt: now,
  });

  user.sessions = sessions.slice(-MAX_ACTIVE_SESSIONS);
  await user.save();
  await authSessionCache.invalidate(normalizeUserId(user));
}

async function issueTokenPair(user, { deviceId } = {}) {
  const access = signAccessToken(user, { deviceId });
  const refresh = signRefreshToken(user, { deviceId: access.deviceId });
  await upsertSession(user, access.deviceId, refresh.refreshTokenHash);

  return {
    token: access.accessToken,
    refreshToken: refresh.refreshToken,
    deviceId: access.deviceId,
  };
}

async function invalidateAllUserTokens(user, { revokeSensitive = false } = {}) {
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  user.refreshTokenVersion = (user.refreshTokenVersion ?? 0) + 1;
  user.sessions = [];
  await user.save();
  await authSessionCache.invalidate(normalizeUserId(user));

  if (revokeSensitive && user.role === "admin") {
    await bumpSensitiveTokenVersion();
  }

  return user;
}

async function refreshTokenPair(user, refreshTokenRaw, { deviceId } = {}) {
  const decoded = verifyJwt(refreshTokenRaw);
  const { deviceId: sessionDeviceId, session } = validateRefreshClaims(decoded, user, refreshTokenRaw);

  const resolvedDeviceId = deviceId?.trim() || sessionDeviceId;
  if (resolvedDeviceId !== sessionDeviceId) {
    throw authError("Session device mismatch", "SESSION_DEVICE_MISMATCH");
  }

  session.lastUsedAt = new Date();
  await user.save();

  return issueTokenPair(user, { deviceId: resolvedDeviceId });
}

function extractBearerToken(req) {
  const header = req.headers?.authorization || req.header?.("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.split(" ")[1] || null;
}

function extractDeviceId(req) {
  return req.headers?.["x-device-id"] || req.header?.("x-device-id") || null;
}

module.exports = {
  REFRESH_TOKEN_TYPE,
  hashToken,
  generateDeviceId,
  verifyJwt,
  validateAccessClaims,
  validateRefreshClaims,
  signAccessToken,
  signRefreshToken,
  issueTokenPair,
  invalidateAllUserTokens,
  refreshTokenPair,
  bumpSensitiveTokenVersion,
  getSensitiveTokenVersion,
  extractBearerToken,
  extractDeviceId,
  authError,
};
