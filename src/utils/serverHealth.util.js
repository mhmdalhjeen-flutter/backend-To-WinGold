const os = require("os");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { safeLog } = require("./logSanitize.util");
const { collectDbHealthAsync } = require("./dbHealth.util");
const { getStats: getCacheStats } = require("./responseCache.util");
const { getStats: getAuthCacheStats } = require("./authSessionCache.util");
const { isRedisEnabled } = require("../config/redis");

const LOG_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_LOOP_DEGRADED_MEAN_MS = 100;
const EVENT_LOOP_DEGRADED_MAX_MS = 500;
const EVENT_LOOP_CRITICAL_MEAN_MS = 500;
const EVENT_LOOP_CRITICAL_MAX_MS = 2000;

let loopMonitor = null;
let lastCpuSample = null;
let logTimer = null;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function getEventLoopHealth() {
  if (!loopMonitor) {
    return { status: "unknown", meanMs: null, maxMs: null, p99Ms: null };
  }

  const meanMs = loopMonitor.mean / 1e6;
  const maxMs = loopMonitor.max / 1e6;
  const p99Ms = loopMonitor.percentile(99) / 1e6;

  let status = "healthy";
  if (meanMs >= EVENT_LOOP_CRITICAL_MEAN_MS || maxMs >= EVENT_LOOP_CRITICAL_MAX_MS) {
    status = "critical";
  } else if (meanMs >= EVENT_LOOP_DEGRADED_MEAN_MS || maxMs >= EVENT_LOOP_DEGRADED_MAX_MS) {
    status = "degraded";
  }

  loopMonitor.reset();

  return {
    status,
    meanMs: round(meanMs),
    maxMs: round(maxMs),
    p99Ms: round(p99Ms),
  };
}

function getCpuMetrics() {
  const currentUsage = process.cpuUsage();
  const now = Date.now();
  let processPercent = null;

  if (lastCpuSample) {
    const elapsedMs = Math.max(now - lastCpuSample.at, 1);
    const userDelta = (currentUsage.user - lastCpuSample.usage.user) / 1000;
    const systemDelta = (currentUsage.system - lastCpuSample.usage.system) / 1000;
    processPercent = round(((userDelta + systemDelta) / elapsedMs) * 100);
  }

  lastCpuSample = { usage: currentUsage, at: now };

  return {
    processPercent,
    cores: os.cpus().length,
    loadAvg: os.loadavg().map((v) => round(v)),
    userMicros: currentUsage.user,
    systemMicros: currentUsage.system,
  };
}

function getMemoryMetrics() {
  const proc = process.memoryUsage();
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    process: {
      rssMb: round(proc.rss / 1024 / 1024),
      heapUsedMb: round(proc.heapUsed / 1024 / 1024),
      heapTotalMb: round(proc.heapTotal / 1024 / 1024),
      externalMb: round(proc.external / 1024 / 1024),
    },
    system: {
      totalMb: round(total / 1024 / 1024),
      freeMb: round(free / 1024 / 1024),
      usedMb: round(used / 1024 / 1024),
      usedPercent: round((used / total) * 100),
    },
  };
}

function getDatabaseHealthPlaceholder() {
  return {
    status: "unknown",
    readyState: null,
    note: "Use collectDbHealthAsync for full MongoDB metrics",
  };
}

async function collectServerHealthAsync(options = {}) {
  const mongodb = await collectDbHealthAsync(options);

  return {
    uptimeSeconds: round(process.uptime(), 0),
    uptimeHuman: formatUptime(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    cpu: getCpuMetrics(),
    memory: getMemoryMetrics(),
    eventLoop: getEventLoopHealth(),
    database: mongodb,
    timestamp: new Date().toISOString(),
  };
}

function collectServerHealth() {
  return {
    uptimeSeconds: round(process.uptime(), 0),
    uptimeHuman: formatUptime(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    cpu: getCpuMetrics(),
    memory: getMemoryMetrics(),
    eventLoop: getEventLoopHealth(),
    database: getDatabaseHealthPlaceholder(),
    timestamp: new Date().toISOString(),
  };
}

function resolveOverallStatus(metrics) {
  const dbStatus = metrics.database?.status;
  if (dbStatus === "unhealthy" || metrics.database?.connection?.status !== "connected") {
    return "unhealthy";
  }
  if (dbStatus === "degraded") return "degraded";
  if (metrics.eventLoop.status === "critical") return "degraded";
  if (metrics.eventLoop.status === "degraded") return "degraded";
  return "healthy";
}

async function getHealthCheckResponse() {
  const server = await collectServerHealthAsync({ useCachedPing: true });
  return {
    status: resolveOverallStatus(server),
    timestamp: server.timestamp,
    server,
    scaling: {
      worker: process.env.NODE_APP_INSTANCE ?? "single",
      pid: process.pid,
      redis: isRedisEnabled(),
      responseCache: getCacheStats(),
      authSessionCache: getAuthCacheStats(),
    },
  };
}

function logServerHealth() {
  collectDbHealthAsync()
    .then((mongodb) => {
      const snapshot = {
        ...collectServerHealth(),
        database: mongodb,
      };
      const level = snapshot.eventLoop.status === "critical" || mongodb.status === "unhealthy"
        ? "error"
        : snapshot.eventLoop.status === "degraded" || mongodb.status === "degraded"
          ? "warn"
          : "info";
      safeLog(level, "server_health", snapshot);
    })
    .catch((error) => {
      safeLog("error", "server_health_log_failed", { message: error.message });
    });
}

function startServerHealthMonitoring() {
  if (loopMonitor) return;

  loopMonitor = monitorEventLoopDelay({ resolution: 20 });
  loopMonitor.enable();
  lastCpuSample = { usage: process.cpuUsage(), at: Date.now() };

  logTimer = setInterval(logServerHealth, LOG_INTERVAL_MS);
  logTimer.unref();
}

module.exports = {
  collectServerHealth,
  getHealthCheckResponse,
  startServerHealthMonitoring,
  logServerHealth,
};
