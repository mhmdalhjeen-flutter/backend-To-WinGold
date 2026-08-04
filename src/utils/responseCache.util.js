/**
 * Hybrid response cache: L1 in-memory (per-process micro-cache) + L2 Redis (shared).
 * In-flight request deduplication works across PM2 workers when Redis is available.
 */

const { isRedisEnabled, getRedis, prefixKey } = require("../config/redis");

const DEFAULT_TTL_MS = 45_000;
const DEDUPE_WINDOW_MS = 8_000;
const MAX_ENTRIES = 10_000;
const L1_TTL_WHEN_REDIS_MS = 3_000;

const store = new Map();
const inFlight = new Map();

const stats = {
  hits: 0,
  misses: 0,
  deduped: 0,
  invalidations: 0,
  redisHits: 0,
  redisMisses: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.at > entry.ttlMs) store.delete(key);
    if (store.size <= MAX_ENTRIES * 0.8) break;
  }
}

function getL1(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= entry.ttlMs) {
    store.delete(key);
    return null;
  }
  return { status: entry.status, body: entry.body };
}

function setL1(key, status, body, ttlMs) {
  const effectiveTtl = isRedisEnabled() ? Math.min(ttlMs, L1_TTL_WHEN_REDIS_MS) : ttlMs;
  store.set(key, { at: Date.now(), ttlMs: effectiveTtl, status, body });
  pruneIfNeeded();
}

async function getFromRedis(key) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(prefixKey(`cache:${key}`));
    if (!raw) {
      stats.redisMisses++;
      return null;
    }
    const parsed = JSON.parse(raw);
    stats.redisHits++;
    return { status: parsed.status, body: parsed.body };
  } catch {
    stats.redisMisses++;
    return null;
  }
}

async function setToRedis(key, status, body, ttlMs) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await redis.set(
      prefixKey(`cache:${key}`),
      JSON.stringify({ status, body }),
      "EX",
      ttlSec
    );
  } catch {
    /* non-fatal */
  }
}

async function deleteFromRedis(keyOrPrefix) {
  const redis = getRedis();
  if (!redis) return;
  const prefix = prefixKey(`cache:${keyOrPrefix}`);
  try {
    if (!keyOrPrefix.includes(":") || keyOrPrefix.endsWith(":")) {
      const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
      const keys = [];
      for await (const batch of stream) {
        keys.push(...batch);
      }
      if (keys.length) await redis.del(...keys);
    } else {
      await redis.del(prefix);
    }
  } catch {
    /* non-fatal */
  }
}

function get(key) {
  const hit = getL1(key);
  if (hit) {
    stats.hits++;
    return hit;
  }
  stats.misses++;
  return null;
}

async function getAsync(key) {
  const l1 = getL1(key);
  if (l1) {
    stats.hits++;
    return l1;
  }

  const redisHit = await getFromRedis(key);
  if (redisHit) {
    stats.hits++;
    setL1(key, redisHit.status, redisHit.body, DEFAULT_TTL_MS);
    return redisHit;
  }

  stats.misses++;
  return null;
}

function set(key, status, body, ttlMs = DEFAULT_TTL_MS) {
  if (status < 200 || status >= 300) return;
  setL1(key, status, body, ttlMs);
  setToRedis(key, status, body, ttlMs).catch(() => {});
}

async function setAsync(key, status, body, ttlMs = DEFAULT_TTL_MS) {
  if (status < 200 || status >= 300) return;
  setL1(key, status, body, ttlMs);
  await setToRedis(key, status, body, ttlMs);
}

function invalidate(keyOrPrefix) {
  const prefix = String(keyOrPrefix);
  let removed = 0;
  for (const key of store.keys()) {
    if (key === prefix || key.startsWith(prefix)) {
      store.delete(key);
      removed++;
    }
  }
  for (const key of inFlight.keys()) {
    if (key === prefix || key.startsWith(prefix)) {
      inFlight.delete(key);
    }
  }
  deleteFromRedis(prefix).catch(() => {});
  if (removed > 0) stats.invalidations += removed;
  return removed;
}

async function invalidateAsync(keyOrPrefix) {
  return invalidate(keyOrPrefix);
}

function invalidateUser(userId) {
  const uid = String(userId);
  invalidate(`user:me:${uid}`);
  invalidate(`notif:list:${uid}:`);
  invalidate(`notif:unread:${uid}`);
  invalidate(`chat:unread:${uid}`);
  invalidate(`cart:${uid}`);
}

function peekInFlight(key, dedupeMs = DEDUPE_WINDOW_MS) {
  const existing = inFlight.get(key);
  if (existing && Date.now() - existing.at < dedupeMs) {
    return existing.promise;
  }
  return null;
}

function trackInFlight(key, promise, dedupeMs = DEDUPE_WINDOW_MS) {
  inFlight.set(key, { at: Date.now(), promise });
  promise.finally(() => {
    setTimeout(() => {
      const entry = inFlight.get(key);
      if (entry?.promise === promise) {
        inFlight.delete(key);
      }
    }, dedupeMs);
  });
}

async function acquireInflightLock(key, dedupeMs = DEDUPE_WINDOW_MS) {
  const redis = getRedis();
  if (!redis) return true;

  try {
    const lockKey = prefixKey(`inflight:${key}`);
    const result = await redis.set(lockKey, String(process.pid), "PX", dedupeMs, "NX");
    return result === "OK";
  } catch {
    return true;
  }
}

async function releaseInflightLock(key) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(prefixKey(`inflight:${key}`));
  } catch {
    /* ignore */
  }
}

async function waitForSharedInflight(key, dedupeMs = DEDUPE_WINDOW_MS) {
  const redis = getRedis();
  if (!redis) return null;

  const deadline = Date.now() + dedupeMs;
  while (Date.now() < deadline) {
    const hit = await getFromRedis(key);
    if (hit) {
      stats.deduped++;
      return hit;
    }
    try {
      const exists = await redis.exists(prefixKey(`inflight:${key}`));
      if (!exists) break;
    } catch {
      break;
    }
    await sleep(25);
  }
  return null;
}

function statsDeduped() {
  stats.deduped++;
}

function getStats() {
  return {
    ...stats,
    size: store.size,
    inFlight: inFlight.size,
    redis: isRedisEnabled(),
  };
}

function resetStats() {
  stats.hits = 0;
  stats.misses = 0;
  stats.deduped = 0;
  stats.invalidations = 0;
  stats.redisHits = 0;
  stats.redisMisses = 0;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEDUPE_WINDOW_MS,
  get,
  getAsync,
  set,
  setAsync,
  invalidate,
  invalidateAsync,
  invalidateUser,
  peekInFlight,
  trackInFlight,
  acquireInflightLock,
  releaseInflightLock,
  waitForSharedInflight,
  statsDeduped,
  getStats,
  resetStats,
};
