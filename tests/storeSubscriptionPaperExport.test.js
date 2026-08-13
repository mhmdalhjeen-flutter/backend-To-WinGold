/**
 * Store subscription paper export lookup — run with: node tests/storeSubscriptionPaperExport.test.js
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { resolvePeriodStoreId } = require("../src/services/storeSubscription.service");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
    }
  })();
}

console.log("\nStore Subscription Paper Export Tests\n");

const tests = [];

tests.push(test("resolvePeriodStoreId reads populated store document", () => {
  const storeId = new mongoose.Types.ObjectId();
  assert.strictEqual(
    String(resolvePeriodStoreId({ store: { _id: storeId, name: "Demo" } })),
    String(storeId),
  );
}));

tests.push(test("resolvePeriodStoreId reads raw ObjectId store reference", () => {
  const storeId = new mongoose.Types.ObjectId();
  assert.strictEqual(String(resolvePeriodStoreId({ store: storeId })), String(storeId));
}));

tests.push(test("resolvePeriodStoreId returns null when store missing", () => {
  assert.strictEqual(resolvePeriodStoreId({}), null);
  assert.strictEqual(resolvePeriodStoreId(null), null);
}));

Promise.all(tests).then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
