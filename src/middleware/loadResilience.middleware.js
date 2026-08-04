const { isRedisEnabled, getRedis, prefixKey } = require("../config/redis");
const { getStats: getCacheStats } = require("../utils/responseCache.util");

const SPIKE_WINDOW_MS = Number(process.env.SPIKE_WINDOW_MS) || 5000;
const SPIKE_MAX_PER_USER = Number(process.env.SPIKE_MAX_PER_USER) || 80;
const SPIKE_MAX_PER_IP = Number(process.env.SPIKE_MAX_PER_IP) || 120;
const DEGRADE_LOAD_THRESHOLD = Number(process.env.DEGRADE_LOAD_THRESHOLD) || 200;

const localSpikes = new Map();

const HEAVY_PATHS = new Set([
  "/api/users/me",
  "/api/v1/users/me",
  "/api/notifications",
  "/api/v1/notifications",
  "/api/cart",
  "/api/v1/cart",
]);

function spikeKey(kind, id) {
  return `spike:${kind}:${id}`;
}

async function incrementSpike(kind, id) {
  const redis = getRedis();
  const key = prefixKey(spikeKey(kind, id));
  const windowSec = Math.ceil(SPIKE_WINDOW_MS / 1000);

  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      return count;
    } catch {
      /* fall through */
    }
  }

  const localKey = `${kind}:${id}`;
  const now = Date.now();
  let bucket = localSpikes.get(localKey);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + SPIKE_WINDOW_MS };
  }
  bucket.count += 1;
  localSpikes.set(localKey, bucket);
  return bucket.count;
}

function softThrottleMiddleware(req, res, next) {
  if (req.method !== "GET") return next();

  const userId = req.user?.id?.toString();
  const ip = req.ip || "unknown";

  Promise.all([
    userId ? incrementSpike("user", userId) : Promise.resolve(0),
    incrementSpike("ip", ip),
  ])
    .then(([userCount, ipCount]) => {
      const limit = userId ? SPIKE_MAX_PER_USER : SPIKE_MAX_PER_IP;
      const count = userId ? userCount : ipCount;
      if (count > limit) {
        res.set("Retry-After", "2");
        return res.status(429).json({
          message: "طلبات كثيرة — يرجى الانتظار لحظات",
          code: "SPIKE_THROTTLE",
        });
      }
      next();
    })
    .catch(() => next());
}

function gracefulDegradationMiddleware(req, res, next) {
  if (req.method !== "GET" || !HEAVY_PATHS.has(req.path)) return next();

  const cacheStats = getCacheStats();
  const loadSignal = cacheStats.inFlight;
  if (loadSignal < DEGRADE_LOAD_THRESHOLD) return next();

  res.set("X-Degraded", "1");
  next();
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of localSpikes) {
    if (now > bucket.resetAt) localSpikes.delete(key);
  }
}, 30_000);
cleanupTimer.unref();

module.exports = {
  softThrottleMiddleware,
  gracefulDegradationMiddleware,
  incrementSpike,
  isRedisEnabled,
};
