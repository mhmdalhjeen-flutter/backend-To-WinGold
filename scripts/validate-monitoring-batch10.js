/**
 * Batch 10.5 — Monitoring validation (read-only against running server + local unit checks).
 * Usage: node scripts/validate-monitoring-batch10.js [BASE_URL]
 */
const BASE = process.argv[2] || "http://127.0.0.1:5000";

const results = [];

function pass(name, detail = "") {
  results.push({ name, status: "PASS", detail });
}

function fail(name, detail = "") {
  results.push({ name, status: "FAIL", detail });
}

function warn(name, detail = "") {
  results.push({ name, status: "WARN", detail });
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

function validateHealthSchema(data) {
  const issues = [];
  if (!data?.success) issues.push("missing success:true");
  if (!data?.data?.status) issues.push("missing data.status");
  const s = data?.data?.server;
  if (!s) issues.push("missing data.server");
  else {
    for (const key of ["uptimeSeconds", "cpu", "memory", "eventLoop", "database"]) {
      if (!(key in s)) issues.push(`missing server.${key}`);
    }
    const db = s.database;
    if (!db?.connection) issues.push("missing database.connection");
    if (!db?.pool) issues.push("missing database.pool");
    if (!db?.queries) issues.push("missing database.queries");
    if (db?.connection?.status !== "connected") issues.push(`database not connected: ${db?.connection?.status}`);
  }
  return issues;
}

async function runLiveTests() {
  try {
    const health = await fetchJson("/api/v1/health");
    if (health.res.status !== 200) {
      fail("health_endpoint_http", `expected 200 got ${health.res.status}`);
    } else {
      pass("health_endpoint_http", "GET /api/v1/health → 200");
    }

    const issues = validateHealthSchema(health.body);
    if (issues.length) fail("health_endpoint_schema", issues.join("; "));
    else pass("health_endpoint_schema", `status=${health.body.data.status}, db=${health.body.data.server.database.connection.status}`);

    const meta = await fetchJson("/api/v1/");
    if (meta.res.status === 200 && meta.body?.success) pass("health_whitelist_meta", "GET /api/v1/ → 200 during maintenance whitelist");
    else warn("health_whitelist_meta", `status=${meta.res.status}`);

    const notFound = await fetchJson("/api/v1/this-route-does-not-exist-batch10");
    if (notFound.res.status === 404) pass("failed_request_404", "Unknown route → 404");
    else fail("failed_request_404", `expected 404 got ${notFound.res.status}`);

    const noAuth = await fetchJson("/api/users/me");
    if (noAuth.res.status === 401) pass("failed_request_401", "GET /api/users/me without token → 401");
    else fail("failed_request_401", `expected 401 got ${noAuth.res.status}`);

    const badToken = await fetchJson("/api/users/me", {
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    if (badToken.res.status === 401) pass("failed_request_bad_jwt", "Invalid JWT → 401");
    else fail("failed_request_bad_jwt", `expected 401 got ${badToken.res.status}`);

    const cors = await fetch(`${BASE}/api/v1/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    if (cors.status === 403 || cors.status === 500) pass("failed_request_cors", `Rejected foreign Origin → ${cors.status}`);
    else warn("failed_request_cors", `Origin rejection returned ${cors.status} (dev may allow open CORS)`);
  } catch (err) {
    fail("live_server", err.message);
  }
}

function runLocalLogTests() {
  const { safeLog, sanitizeForLog } = require("../src/utils/logSanitize.util");
  const lines = [];
  const capture = (stream) => (...args) => lines.push({ stream, line: args[0] });

  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = capture("stdout");
  console.warn = capture("stderr");
  console.error = capture("stderr");

  try {
    safeLog("info", "validation_test_info", { ok: true });
    safeLog("warn", "http_request", { method: "GET", path: "/api/test", status: 404, durationMs: 3 });
    safeLog("error", "server_error", { message: "simulated", status: 500 });
    safeLog("warn", "mongodb_slow_query", { durationMs: 600, command: "find", collection: "offers" });

    const sanitized = sanitizeForLog({ password: "secret", email: "a@b.com", nested: { token: "x" } });
    if (sanitized.password === "[redacted]" && sanitized.nested.token === "[redacted]") {
      pass("log_sanitization", "Sensitive keys redacted");
    } else {
      fail("log_sanitization", JSON.stringify(sanitized));
    }

    for (const { stream, line } of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("log_json_parse", `Non-JSON line on ${stream}`);
        continue;
      }
      if (!parsed.at || !parsed.event) {
        fail("log_envelope", `Missing at/event in ${parsed.event || "?"}`);
      }
    }
    if (lines.length >= 4) pass("log_json_parse", `${lines.length} log lines parse as JSON with at+event`);
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

function runComponentInventory() {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");

  const required = [
    "src/utils/logSanitize.util.js",
    "src/middleware/requestLog.middleware.js",
    "src/utils/serverHealth.util.js",
    "src/utils/dbHealth.util.js",
    "src/services/audit.service.js",
    "src/routes/v1/meta.routes.js",
  ];

  for (const file of required) {
    if (fs.existsSync(path.join(root, file))) pass("component_exists", file);
    else fail("component_exists", `missing ${file}`);
  }

  const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
  if (serverJs.includes("requestLogMiddleware") && serverJs.includes("startServerHealthMonitoring")) {
    pass("component_wired_server", "requestLog + serverHealth in server.js");
  } else {
    fail("component_wired_server", "missing middleware wiring");
  }

  const dbJs = fs.readFileSync(path.join(root, "src/config/db.js"), "utf8");
  if (dbJs.includes("monitorCommands") && dbJs.includes("setupDbMonitoring")) {
    pass("component_wired_db", "MongoDB monitoring in db.js");
  } else {
    fail("component_wired_db", "missing db monitoring");
  }
}

async function main() {
  console.log(`Batch 10.5 Monitoring Validation\nBase URL: ${BASE}\n`);

  runComponentInventory();
  runLocalLogTests();
  await runLiveTests();

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warnings = results.filter((r) => r.status === "WARN").length;

  console.log("| Status | Check | Detail |");
  console.log("|--------|-------|--------|");
  for (const r of results) {
    console.log(`| ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, "/")} |`);
  }
  console.log(`\nSummary: ${passed} pass, ${failed} fail, ${warnings} warn`);

  const outPath = require("path").join(__dirname, "..", "_batch10_validation.json");
  require("fs").writeFileSync(outPath, JSON.stringify({ base: BASE, summary: { passed, failed, warnings }, results }, null, 2));
  console.log(`\nWritten: ${outPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
