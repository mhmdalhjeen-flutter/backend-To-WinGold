/**
 * Delivery session unit tests — run with: node tests/deliverySession.test.js
 * No external test framework required.
 */
const assert = require("assert");
const deliveryPricingService = require("../src/services/deliveryPricing.service");
const {
  SESSION_STATUSES,
  allStoresApproved,
  deriveInitialSubmittedStatus,
  normalizeSessionStatus,
} = require("../src/constants/deliverySession.constants");

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

console.log("\nDelivery Session Tests\n");

// Scenario 1 — pricing: 3 delivery orders
test("Scenario 1: fee for 3 orders = base + 2×extra", () => {
  const fee = deliveryPricingService.calculateFeeFromCompany(
    { basePrice: 10, extraOrderPrice: 3, currency: "ILS" },
    3,
  );
  assert.strictEqual(fee.totalFee, 16);
  assert.strictEqual(fee.orderCount, 3);
  assert.strictEqual(fee.extraOrderCount, 2);
});

test("Scenario 1: only delivery orders concept — pickup excluded at service layer", () => {
  const { DELIVERY_METHODS } = require("../src/constants/marketplaceOrder.constants");
  assert.strictEqual(DELIVERY_METHODS.DELIVERY, "delivery");
  assert.notStrictEqual(DELIVERY_METHODS.PICKUP, DELIVERY_METHODS.DELIVERY);
});

// Scenario 2 — confirm before all stores approve
test("Scenario 2: partial store approval → waiting_for_stores", () => {
  const stops = [
    { orderStatus: "store_accepted" },
    { orderStatus: "pending" },
  ];
  assert.strictEqual(deriveInitialSubmittedStatus(stops), SESSION_STATUSES.WAITING_FOR_STORES);
  assert.strictEqual(allStoresApproved(stops), false);
});

// Scenario 3 — all stores approve
test("Scenario 3: all stores approved → ready_for_pickup", () => {
  const stops = [
    { orderStatus: "store_accepted" },
    { orderStatus: "preparing" },
    { orderStatus: "delivered_to_driver" },
  ];
  assert.strictEqual(allStoresApproved(stops), true);
  assert.strictEqual(deriveInitialSubmittedStatus(stops), SESSION_STATUSES.READY_FOR_PICKUP);
});

// Scenario 4 — status normalization (legacy → canonical)
test("Scenario 4: legacy status mapping", () => {
  assert.strictEqual(normalizeSessionStatus("driver_assigned"), SESSION_STATUSES.ACCEPTED);
  assert.strictEqual(normalizeSessionStatus("on_the_way"), SESSION_STATUSES.OUT_FOR_DELIVERY);
  assert.strictEqual(normalizeSessionStatus("delivered"), SESSION_STATUSES.COMPLETED);
  assert.strictEqual(normalizeSessionStatus("collecting_orders"), SESSION_STATUSES.OUT_FOR_DELIVERY);
});

test("fee for single order equals base only", () => {
  const fee = deliveryPricingService.calculateFeeFromCompany({ basePrice: 10, extraOrderPrice: 3 }, 1);
  assert.strictEqual(fee.totalFee, 10);
  assert.strictEqual(fee.extraOrderCount, 0);
});

test("fee for zero orders is base price with count 0", () => {
  const fee = deliveryPricingService.calculateFeeFromCompany({ basePrice: 10, extraOrderPrice: 3 }, 0);
  assert.strictEqual(fee.totalFee, 10);
  assert.strictEqual(fee.orderCount, 0);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
