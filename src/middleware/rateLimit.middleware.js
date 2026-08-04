const auditService = require("../services/audit.service");
const { isRedisEnabled, getRedis, prefixKey } = require("../config/redis");

const localBuckets = new Map();

/**
 * Rate limiter with Redis backing when available (shared across PM2 workers).
 */
const rateLimit = ({
  windowMs = 15 * 60 * 1000,
  max = 20,
  message = "محاولات كثيرة جداً، يرجى المحاولة لاحقاً",
  keyFn = null,
} = {}) => {
  return async (req, res, next) => {
    const key = keyFn ? keyFn(req) : `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const windowSec = Math.ceil(windowMs / 1000);

    try {
      const redis = getRedis();
      if (redis) {
        const redisKey = prefixKey(`ratelimit:${key}`);
        const count = await redis.incr(redisKey);
        if (count === 1) await redis.expire(redisKey, windowSec);
        const ttl = await redis.ttl(redisKey);
        const resetAt = now + ttl * 1000;

        const remaining = Math.max(0, max - count);
        res.set("X-RateLimit-Limit", String(max));
        res.set("X-RateLimit-Remaining", String(remaining));
        res.set("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

        if (count > max) {
          const retryAfter = Math.max(1, ttl);
          res.set("Retry-After", String(retryAfter));
          if (count === max + 1) {
            auditService.logSecurityEvent(req, {
              action: "Rate limit exceeded",
              details: "تم تجاوز حد الطلبات المسموح",
              severity: "warning",
              metadata: { path: req.originalUrl, method: req.method, max, windowMs, retryAfter, key },
            }).catch(() => {});
          }
          return res.status(429).json({ message, code: "RATE_LIMIT_EXCEEDED" });
        }
        return next();
      }
    } catch {
      /* fall through to in-memory */
    }

    let bucket = localBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    bucket.count += 1;
    localBuckets.set(key, bucket);

    const remaining = Math.max(0, max - bucket.count);
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      if (bucket.count === max + 1) {
        auditService.logSecurityEvent(req, {
          action: "Rate limit exceeded",
          details: "تم تجاوز حد الطلبات المسموح",
          severity: "warning",
          metadata: { path: req.originalUrl, method: req.method, max, windowMs, retryAfter, key },
        }).catch(() => {});
      }
      return res.status(429).json({ message, code: "RATE_LIMIT_EXCEEDED" });
    }
    next();
  };
};

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of localBuckets) {
    if (now > b.resetAt) localBuckets.delete(key);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

module.exports = rateLimit;
