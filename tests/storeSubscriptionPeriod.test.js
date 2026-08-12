/**
 * StoreSubscriptionPeriod paymentMethod validation — run with: node tests/storeSubscriptionPeriod.test.js
 */
const assert = require("assert");
const StoreSubscriptionPeriod = require("../src/models/storeSubscriptionPeriod");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("\nStoreSubscriptionPeriod Model Tests\n");

test("allows creating a period without paymentMethod", () => {
  const period = new StoreSubscriptionPeriod({
    store: "507f1f77bcf86cd799439011",
    monthKey: "2026-08",
    status: "payment_pending",
  });
  const err = period.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(period.paymentMethod, undefined);
});

test("rejects empty string paymentMethod", () => {
  const period = new StoreSubscriptionPeriod({
    store: "507f1f77bcf86cd799439011",
    monthKey: "2026-08",
    status: "payment_pending",
    paymentMethod: "",
  });
  const err = period.validateSync();
  assert.ok(err, "expected validation error");
  assert.ok(err.errors.paymentMethod, "expected paymentMethod error");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
