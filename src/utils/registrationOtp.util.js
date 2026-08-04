const { getRedis, prefixKey } = require("../config/redis");

const REGISTRATION_OTP_TTL_SEC = Number(process.env.REGISTRATION_OTP_TTL_SEC) || 15 * 60;
const REGISTRATION_OTP_KEY_PREFIX = "reg-otp:verified:";

const localVerified = new Map();

function storageKey(phone) {
  return `${REGISTRATION_OTP_KEY_PREFIX}${phone}`;
}

function getLocal(phone) {
  const entry = localVerified.get(phone);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    localVerified.delete(phone);
    return false;
  }
  return true;
}

async function markPhoneVerified(phone) {
  const expiresAt = Date.now() + REGISTRATION_OTP_TTL_SEC * 1000;
  localVerified.set(phone, { expiresAt });

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.set(prefixKey(storageKey(phone)), "1", "EX", REGISTRATION_OTP_TTL_SEC);
  } catch {
    /* non-fatal — in-memory fallback remains */
  }
}

async function isPhoneVerifiedForRegistration(phone) {
  if (getLocal(phone)) return true;

  const redis = getRedis();
  if (!redis) return false;

  try {
    const value = await redis.get(prefixKey(storageKey(phone)));
    return value === "1";
  } catch {
    return getLocal(phone);
  }
}

async function consumePhoneVerification(phone) {
  localVerified.delete(phone);

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.del(prefixKey(storageKey(phone)));
  } catch {
    /* non-fatal */
  }
}

module.exports = {
  REGISTRATION_OTP_TTL_SEC,
  markPhoneVerified,
  isPhoneVerifiedForRegistration,
  consumePhoneVerification,
};
