const User = require("../models/user");
const { AUTH_USER_SELECT } = require("../utils/userSanitize.util");
const { isRedisEnabled, getRedis, prefixKey } = require("../config/redis");

const AUTH_TTL_SEC = Number(process.env.AUTH_SESSION_CACHE_TTL_SEC) || 60;
const AUTH_KEY_PREFIX = "auth:user:";

const localAuth = new Map();
const stats = { hits: 0, misses: 0, invalidations: 0 };

function authKey(userId) {
  return `${AUTH_KEY_PREFIX}${userId}`;
}

function getLocal(userId) {
  const entry = localAuth.get(String(userId));
  if (!entry) return null;
  if (Date.now() - entry.at >= entry.ttlMs) {
    localAuth.delete(String(userId));
    return null;
  }
  return entry.doc;
}

function setLocal(userId, doc) {
  localAuth.set(String(userId), {
    at: Date.now(),
    ttlMs: AUTH_TTL_SEC * 1000,
    doc,
  });
}

async function get(userId, tokenVersion) {
  const uid = String(userId);
  const tv = tokenVersion ?? 0;

  const local = getLocal(uid);
  if (local && (local.tokenVersion ?? 0) === tv) {
    stats.hits++;
    return User.hydrate(local);
  }

  const redis = getRedis();
  if (!redis) {
    stats.misses++;
    return null;
  }

  try {
    const raw = await redis.get(prefixKey(authKey(uid)));
    if (!raw) {
      stats.misses++;
      return null;
    }
    const doc = JSON.parse(raw);
    if ((doc.tokenVersion ?? 0) !== tv) {
      stats.misses++;
      return null;
    }
    setLocal(uid, doc);
    stats.hits++;
    return User.hydrate(doc);
  } catch {
    stats.misses++;
    return null;
  }
}

async function set(userId, userDoc) {
  const uid = String(userId);
  const plain = userDoc?.toObject ? userDoc.toObject() : { ...userDoc };
  setLocal(uid, plain);

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.set(prefixKey(authKey(uid)), JSON.stringify(plain), "EX", AUTH_TTL_SEC);
  } catch {
    /* non-fatal */
  }
}

async function invalidate(userId) {
  const uid = String(userId);
  localAuth.delete(uid);
  stats.invalidations++;

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.del(prefixKey(authKey(uid)));
  } catch {
    /* non-fatal */
  }
}

async function loadFromDb(userId) {
  const user = await User.findById(userId).select(AUTH_USER_SELECT);
  if (user) await set(userId, user);
  return user;
}

function getStats() {
  return { ...stats, localSize: localAuth.size, redis: isRedisEnabled() };
}

module.exports = {
  get,
  set,
  invalidate,
  loadFromDb,
  getStats,
  AUTH_TTL_SEC,
};
