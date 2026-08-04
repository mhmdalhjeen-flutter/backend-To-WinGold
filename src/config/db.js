const mongoose = require("mongoose");
const { safeLog } = require("../utils/logSanitize.util");
const { setupDbMonitoring } = require("../utils/dbHealth.util");

const CONNECT_RETRIES = Number(process.env.MONGODB_CONNECT_RETRIES) || 5;
const CONNECT_RETRY_DELAY_MS = Number(process.env.MONGODB_CONNECT_RETRY_DELAY_MS) || 2000;

function getConnectOptions() {
  return {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 45000,
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE) || 50,
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE) || 10,
    maxIdleTimeMS: 60000,
    waitQueueTimeoutMS: 10000,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    retryReads: true,
    monitorCommands: true,
  };
}

function isRetryableConnectError(error) {
  const msg = error?.message || "";
  const code = error?.code || error?.cause?.code;
  return (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("Server selection timed out")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const connectDB = async () => {
  const options = getConnectOptions();

  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI, options);
      setupDbMonitoring(conn.connection);

      safeLog("info", "mongodb_connected", {
        host: conn.connection.host,
        attempt,
        maxPoolSize: options.maxPoolSize,
        minPoolSize: options.minPoolSize,
      });
      return;
    } catch (error) {
      const retryable = isRetryableConnectError(error);
      safeLog("error", "mongodb_connection_failed", {
        message: error.message,
        attempt,
        maxAttempts: CONNECT_RETRIES,
        retryable,
        code: error.code || error.cause?.code || null,
      });

      if (attempt < CONNECT_RETRIES && retryable) {
        const waitMs = CONNECT_RETRY_DELAY_MS * attempt;
        safeLog("warn", "mongodb_connection_retry", { attempt, waitMs });
        await delay(waitMs);
        continue;
      }

      process.exit(1);
    }
  }
};

module.exports = connectDB;
