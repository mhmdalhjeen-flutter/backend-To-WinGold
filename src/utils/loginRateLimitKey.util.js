const { normalizeLocalPhone } = require("./phone.util");

const VALID_LOGIN_APP_TYPES = new Set(["customer", "business", "admin", "delivery"]);

function normalizeLoginRateLimitIdentifier(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const normalized = normalizeLocalPhone(trimmed);
  return normalized || null;
}

function loginAccountRateLimitKey(req) {
  const appType = req.body?.appType;
  const identifier = normalizeLoginRateLimitIdentifier(req.body?.identifier);
  if (!VALID_LOGIN_APP_TYPES.has(appType) || !identifier) {
    return `login:ip:${req.ip}`;
  }
  return `login:id:${appType}:${identifier}`;
}

function loginIpRateLimitKey(req) {
  return `login:ip:${req.ip}`;
}

module.exports = {
  normalizeLoginRateLimitIdentifier,
  loginAccountRateLimitKey,
  loginIpRateLimitKey,
  VALID_LOGIN_APP_TYPES,
};
