const mongoose = require("mongoose");
const { safeLog, sanitizeForLog } = require("./logSanitize.util");

const SLOW_QUERY_MS = Number(process.env.MONGODB_SLOW_QUERY_MS) || 500;
const LOG_INTERVAL_MS = 5 * 60 * 1000;
const LATENCY_SAMPLE_MAX = 200;
const SLOW_QUERY_HISTORY_MAX = 10;
const HEALTH_PING_CACHE_MS = Number(process.env.MONGODB_HEALTH_PING_CACHE_MS) || 15000;

const READY_STATE_LABELS = ["disconnected", "connected", "connecting", "disconnecting"];

let monitoringAttached = false;
let logTimer = null;
let lastPingMs = null;
let lastPingAt = null;

const poolStats = {
  maxPoolSize: null,
  minPoolSize: null,
  checkedOut: 0,
  connectionsCreated: 0,
  connectionsClosed: 0,
  checkoutFailed: 0,
};

const queryStats = {
  count: 0,
  totalMs: 0,
  maxMs: 0,
  slowCount: 0,
  slowCountWindow: 0,
  failedCount: 0,
  latencySamples: [],
};

const recentSlowQueries = [];
const pendingCommands = new Map();

function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function extractCollectionName(command) {
  if (!command || typeof command !== "object") return null;
  for (const key of ["find", "insert", "update", "delete", "aggregate", "count", "getMore", "createIndexes"]) {
    const value = command[key];
    if (typeof value === "string") return value;
    if (key === "getMore" && command.collection) return command.collection;
  }
  return null;
}

function recordLatency(durationMs, meta = {}, outcome = "success") {
  queryStats.count += 1;
  queryStats.totalMs += durationMs;
  if (durationMs > queryStats.maxMs) queryStats.maxMs = durationMs;
  if (outcome === "failed") queryStats.failedCount += 1;

  queryStats.latencySamples.push(durationMs);
  if (queryStats.latencySamples.length > LATENCY_SAMPLE_MAX) {
    queryStats.latencySamples.shift();
  }

  if (durationMs >= SLOW_QUERY_MS) {
    queryStats.slowCount += 1;
    queryStats.slowCountWindow += 1;
    const entry = {
      at: new Date().toISOString(),
      durationMs: round(durationMs),
      command: meta.commandName || "unknown",
      collection: meta.collection || null,
      database: meta.databaseName || null,
      outcome,
    };
    recentSlowQueries.unshift(entry);
    if (recentSlowQueries.length > SLOW_QUERY_HISTORY_MAX) {
      recentSlowQueries.length = SLOW_QUERY_HISTORY_MAX;
    }
    safeLog("warn", "mongodb_slow_query", sanitizeForLog(entry));
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function getQueryMetrics() {
  const samples = queryStats.latencySamples;
  const avgMs = queryStats.count > 0 ? queryStats.totalMs / queryStats.count : null;

  return {
    count: queryStats.count,
    avgMs: round(avgMs),
    p95Ms: round(percentile(samples, 95)),
    maxMs: round(queryStats.maxMs),
    slowCount: queryStats.slowCount,
    slowCountWindow: queryStats.slowCountWindow,
    failedCount: queryStats.failedCount,
    slowThresholdMs: SLOW_QUERY_MS,
    recentSlowQueries: recentSlowQueries.slice(0, SLOW_QUERY_HISTORY_MAX),
  };
}

function getConnectionStatus(conn = mongoose.connection) {
  const readyState = conn.readyState;
  const label = READY_STATE_LABELS[readyState] || "unknown";

  return {
    status: readyState === 1 ? "connected" : label,
    readyState,
    host: conn.host || null,
    name: conn.name || null,
    lastPingMs: lastPingMs,
    lastPingAt: lastPingAt,
  };
}

function getPoolMetrics() {
  const max = poolStats.maxPoolSize;
  const checkedOut = Math.max(0, poolStats.checkedOut);

  return {
    maxPoolSize: max,
    minPoolSize: poolStats.minPoolSize,
    checkedOut,
    available: max != null ? Math.max(0, max - checkedOut) : null,
    connectionsCreated: poolStats.connectionsCreated,
    connectionsClosed: poolStats.connectionsClosed,
    checkoutFailed: poolStats.checkoutFailed,
  };
}

function resolveDbStatus(connection, queries) {
  if (connection.status !== "connected") return "unhealthy";
  if (queries.slowCountWindow > 0 && queries.p95Ms != null && queries.p95Ms >= SLOW_QUERY_MS) {
    return "degraded";
  }
  if (lastPingMs != null && lastPingMs >= SLOW_QUERY_MS) return "degraded";
  return "healthy";
}

function collectDbHealth() {
  const connection = getConnectionStatus();
  const pool = getPoolMetrics();
  const queries = getQueryMetrics();

  return {
    status: resolveDbStatus(connection, queries),
    connection,
    pool,
    queries,
    timestamp: new Date().toISOString(),
  };
}

async function pingDatabase(options = {}) {
  const { useCache = false } = options;
  const conn = mongoose.connection;
  if (conn.readyState !== 1 || !conn.db) {
    lastPingMs = null;
    lastPingAt = new Date().toISOString();
    return null;
  }

  if (useCache && lastPingAt && lastPingMs != null) {
    const ageMs = Date.now() - new Date(lastPingAt).getTime();
    if (ageMs >= 0 && ageMs < HEALTH_PING_CACHE_MS) {
      return lastPingMs;
    }
  }

  const start = process.hrtime.bigint();
  await conn.db.command({ ping: 1 });
  const pingMs = Number(process.hrtime.bigint() - start) / 1e6;
  lastPingMs = round(pingMs);
  lastPingAt = new Date().toISOString();
  return lastPingMs;
}

function setupDbMonitoring(connection) {
  if (monitoringAttached) return;
  monitoringAttached = true;

  const client = connection.getClient?.();
  if (!client) {
    safeLog("warn", "mongodb_monitor_setup_skipped", { reason: "client unavailable" });
    return;
  }

  const options = client.options || connection.client?.options || {};
  poolStats.maxPoolSize = options.maxPoolSize ?? 20;
  poolStats.minPoolSize = options.minPoolSize ?? 0;

  client.on("connectionPoolCreated", (event) => {
    if (event.options?.maxPoolSize != null) poolStats.maxPoolSize = event.options.maxPoolSize;
    if (event.options?.minPoolSize != null) poolStats.minPoolSize = event.options.minPoolSize;
  });

  client.on("connectionCheckedOut", () => {
    poolStats.checkedOut += 1;
  });

  client.on("connectionCheckedIn", () => {
    poolStats.checkedOut = Math.max(0, poolStats.checkedOut - 1);
  });

  client.on("connectionCreated", () => {
    poolStats.connectionsCreated += 1;
  });

  client.on("connectionClosed", () => {
    poolStats.connectionsClosed += 1;
    poolStats.checkedOut = Math.max(0, poolStats.checkedOut - 1);
  });

  client.on("connectionCheckOutFailed", () => {
    poolStats.checkoutFailed += 1;
    safeLog("warn", "mongodb_pool_checkout_failed", {
      checkedOut: poolStats.checkedOut,
      maxPoolSize: poolStats.maxPoolSize,
      available: poolStats.maxPoolSize != null
        ? Math.max(0, poolStats.maxPoolSize - poolStats.checkedOut)
        : null,
    });
  });

  client.on("commandStarted", (event) => {
    pendingCommands.set(event.requestId, {
      commandName: event.commandName,
      databaseName: event.databaseName,
      collection: extractCollectionName(event.command),
      startedAt: Date.now(),
    });
  });

  const finishCommand = (event, outcome) => {
    const pending = pendingCommands.get(event.requestId);
    pendingCommands.delete(event.requestId);
    const durationMs = typeof event.duration === "number"
      ? event.duration
      : pending?.startedAt
        ? Date.now() - pending.startedAt
        : 0;

    recordLatency(durationMs, pending || { commandName: event.commandName }, outcome);
  };

  client.on("commandSucceeded", (event) => finishCommand(event, "success"));
  client.on("commandFailed", (event) => finishCommand(event, "failed"));

  connection.on("disconnected", () => {
    safeLog("warn", "mongodb_disconnected", { host: connection.host, readyState: connection.readyState });
  });

  connection.on("reconnected", () => {
    safeLog("info", "mongodb_reconnected", { host: connection.host });
  });

  connection.on("error", (error) => {
    const isDns = error.message?.includes("ENOTFOUND") || error.code === "ENOTFOUND";
    safeLog("error", "mongodb_connection_error", {
      message: error.message,
      code: error.code || null,
      isDns,
    });
  });

  logTimer = setInterval(logDbHealth, LOG_INTERVAL_MS);
  logTimer.unref();

  safeLog("info", "mongodb_monitoring_started", {
    slowQueryThresholdMs: SLOW_QUERY_MS,
    maxPoolSize: poolStats.maxPoolSize,
  });
}

function logDbHealth() {
  const snapshot = collectDbHealth();
  const level = snapshot.status === "unhealthy" ? "error"
    : snapshot.status === "degraded" ? "warn"
      : "info";
  safeLog(level, "mongodb_health", snapshot);

  queryStats.count = 0;
  queryStats.totalMs = 0;
  queryStats.maxMs = 0;
  queryStats.slowCountWindow = 0;
  queryStats.failedCount = 0;
  queryStats.latencySamples.length = 0;
}

async function collectDbHealthAsync(options = {}) {
  const { useCachedPing = false } = options;
  await pingDatabase({ useCache: useCachedPing });
  return collectDbHealth();
}

module.exports = {
  collectDbHealth,
  collectDbHealthAsync,
  getConnectionStatus,
  getPoolMetrics,
  getQueryMetrics,
  pingDatabase,
  setupDbMonitoring,
  logDbHealth,
  SLOW_QUERY_MS,
};
