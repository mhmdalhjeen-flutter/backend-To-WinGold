const cache = require("../utils/responseCache.util");
const { incrementSpike } = require("../middleware/loadResilience.middleware");

const SPIKE_MAX_PER_USER = Number(process.env.SPIKE_MAX_PER_USER) || 80;

/**
 * Cache GET responses after auth. Serves cached JSON or dedupes in-flight
 * identical requests within dedupeMs (cross-worker when Redis is available).
 */
function responseCache({ keyFn, ttlMs = cache.DEFAULT_TTL_MS, dedupeMs = cache.DEDUPE_WINDOW_MS } = {}) {
  return async (req, res, next) => {
    if (req.method !== "GET" || !req.user?.id) return next();

    const key = keyFn(req);

    try {
      const userCount = await incrementSpike("user", req.user.id.toString());
      if (userCount > SPIKE_MAX_PER_USER) {
        res.set("Retry-After", "2");
        return res.status(429).json({
          message: "طلبات كثيرة — يرجى الانتظار لحظات",
          code: "SPIKE_THROTTLE",
        });
      }

      const hit = await cache.getAsync(key);
      if (hit) {
        return res.status(hit.status).json(hit.body);
      }

      const sharedHit = await cache.waitForSharedInflight(key, dedupeMs);
      if (sharedHit?.body != null) {
        return res.status(sharedHit.status).json(sharedHit.body);
      }

      const existing = cache.peekInFlight(key, dedupeMs);
      if (existing) {
        cache.statsDeduped();
        existing
          .then((result) => {
            if (result?.body != null && !res.headersSent) {
              res.status(result.status).json(result.body);
            }
          })
          .catch((err) => next(err));
        return;
      }

      const isLeader = await cache.acquireInflightLock(key, dedupeMs);
      if (!isLeader) {
        const waited = await cache.waitForSharedInflight(key, dedupeMs);
        if (waited?.body != null) {
          return res.status(waited.status).json(waited.body);
        }
      }

      let settled = false;
      let resolveInflight;
      const promise = new Promise((resolve) => {
        resolveInflight = resolve;
      });

      cache.trackInFlight(key, promise, dedupeMs);

      const origJson = res.json.bind(res);
      const origStatus = res.status.bind(res);
      let statusCode = 200;

      res.status = (code) => {
        statusCode = code;
        return origStatus(code);
      };

      res.json = (body) => {
        if (!settled) {
          settled = true;
          cache.setAsync(key, statusCode, body, ttlMs).finally(() => {
            cache.releaseInflightLock(key).catch(() => {});
          });
          resolveInflight({ status: statusCode, body });
        }
        return origJson(body);
      };

      res.once("close", () => {
        if (!settled) {
          settled = true;
          cache.releaseInflightLock(key).catch(() => {});
          resolveInflight({ status: statusCode, body: null });
        }
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}

const userMeCache = responseCache({
  ttlMs: 60_000,
  keyFn: (req) => `user:me:${req.user.id}`,
});

const notificationsListCache = responseCache({
  ttlMs: 45_000,
  keyFn: (req) => {
    const unread = req.query.unread === "true" ? "1" : "0";
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    return `notif:list:${req.user.id}:${unread}:${limit}`;
  },
});

const notificationsUnreadCache = responseCache({
  ttlMs: 30_000,
  keyFn: (req) => `notif:unread:${req.user.id}`,
});

const chatUnreadCache = responseCache({
  ttlMs: 30_000,
  keyFn: (req) => `chat:unread:${req.user.id}`,
});

const cartCache = responseCache({
  ttlMs: 45_000,
  keyFn: (req) => `cart:${req.user.id}`,
});

module.exports = {
  responseCache,
  userMeCache,
  notificationsListCache,
  notificationsUnreadCache,
  chatUnreadCache,
  cartCache,
};
