const Redis = require("ioredis");
const { safeLog } = require("../utils/logSanitize.util");

let client = null;
let enabled = false;

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "offers:";

function isRedisEnabled() {
  return enabled && client?.status === "ready";
}

function getRedis() {
  return isRedisEnabled() ? client : null;
}

function prefixKey(key) {
  return `${KEY_PREFIX}${key}`;
}

async function connectRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    safeLog("warn", "redis_disabled", { reason: "REDIS_URL not set — using in-memory cache only" });
    return false;
  }

  client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 3000,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 1000);
    },
  });

  client.on("error", (err) => {
    safeLog("warn", "redis_error", { message: err.message });
  });

  try {
    await client.connect();
    enabled = true;
    safeLog("info", "redis_connected", { prefix: KEY_PREFIX });
    return true;
  } catch (err) {
    safeLog("warn", "redis_connect_failed", {
      message: err.message,
      fallback: "in-memory cache only",
    });
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    client = null;
    enabled = false;
    return false;
  }
}

async function disconnectRedis() {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
  enabled = false;
}

module.exports = {
  connectRedis,
  disconnectRedis,
  isRedisEnabled,
  getRedis,
  prefixKey,
};
