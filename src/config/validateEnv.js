const { safeLog } = require("../utils/logSanitize.util");

function validateStartupEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const isStrictEnv = nodeEnv === "production" || nodeEnv === "staging";
  const errors = [];

  if (!process.env.JWT_SECRET) {
    errors.push("JWT_SECRET is required");
  }

  if (isStrictEnv && !process.env.MONGO_URI) {
    errors.push("MONGO_URI is required in production/staging");
  }

  if (errors.length) {
    errors.forEach((message) => {
      safeLog("error", "startup_config_error", { message, nodeEnv });
    });
    process.exit(1);
  }

  if (!process.env.MONGO_URI && !isStrictEnv) {
    safeLog("warn", "startup_config_warning", {
      message: "MONGO_URI is not set — database connection will fail until configured",
      nodeEnv,
    });
  }
}

module.exports = { validateStartupEnv };
