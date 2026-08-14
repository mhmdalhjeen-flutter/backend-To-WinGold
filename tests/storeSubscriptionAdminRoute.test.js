/**
 * Store subscription admin route wiring — run with: node tests/storeSubscriptionAdminRoute.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const routesPath = path.join(__dirname, "../src/routes/admin/admin.routes.js");
const routesSource = fs.readFileSync(routesPath, "utf8");

test("store subscription request route uses sensitiveAuth", () => {
  assert.match(
    routesSource,
    /router\.post\("\/store-subscriptions\/request",\s*sensitiveAuth,\s*storeSubscriptionAdmin\.requestStoreSubscriptions\)/,
  );
});

test.after(() => {
  setTimeout(() => process.exit(0), 50);
});

console.log("storeSubscriptionAdminRoute.test.js — all tests registered");
