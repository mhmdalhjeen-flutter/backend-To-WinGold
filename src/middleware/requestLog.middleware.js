const { getClientIp } = require("../utils/requestMeta.util");
const { safeLog } = require("../utils/logSanitize.util");

function requestLogMiddleware(req, res, next) {
  if (!req.originalUrl?.startsWith("/api")) return next();

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const status = res.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

    safeLog(level, "http_request", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status,
      durationMs: Math.round(durationMs),
      ip: getClientIp(req),
      userId: req.user?.id,
      role: req.user?.role,
    });
  });

  next();
}

module.exports = requestLogMiddleware;
