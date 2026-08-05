/**
 * Order status transition unit tests — run with: node tests/orderStatus.test.js
 */
const assert = require("assert");
const {
  canTransition,
  normalizeStatus,
  ALLOWED_TRANSITIONS,
  ALLOWED_STATUSES,
} = require("../src/utils/orderStatus.util");

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

console.log("\nOrder Status Transition Tests\n");

test("legacy: store_accepted → delivered_to_driver is allowed (skip preparing)", () => {
  assert.strictEqual(canTransition("store_accepted", "delivered_to_driver"), true);
});

test("legacy: store_accepted → preparing → delivered_to_driver", () => {
  assert.strictEqual(canTransition("store_accepted", "preparing"), true);
  assert.strictEqual(canTransition("preparing", "delivered_to_driver"), true);
});

test("legacy: delivered_to_driver → delivered_to_customer", () => {
  assert.strictEqual(canTransition("delivered_to_driver", "delivered_to_customer"), true);
});

test("company: pending → ready_for_delivery_pickup → ready_for_driver_pickup → delivery_handover_complete → delivered_to_customer", () => {
  assert.strictEqual(canTransition("pending", "ready_for_delivery_pickup"), true);
  assert.strictEqual(canTransition("ready_for_delivery_pickup", "ready_for_driver_pickup"), true);
  assert.strictEqual(canTransition("ready_for_driver_pickup", "delivery_handover_complete"), true);
  assert.strictEqual(canTransition("delivery_handover_complete", "delivered_to_customer"), true);
});

test("company: ready_for_driver_pickup → delivered_to_driver alias allowed", () => {
  assert.strictEqual(canTransition("ready_for_driver_pickup", "delivered_to_driver"), true);
});

test("company: ready_for_delivery_pickup → delivered_to_driver is blocked", () => {
  assert.strictEqual(canTransition("ready_for_delivery_pickup", "delivered_to_driver"), false);
});

test("rejects skip of company assignment: store_accepted → ready_for_driver_pickup blocked", () => {
  assert.strictEqual(canTransition("store_accepted", "ready_for_driver_pickup"), false);
});

test("rejects reverse transitions", () => {
  assert.strictEqual(canTransition("delivered_to_driver", "store_accepted"), false);
  assert.strictEqual(canTransition("preparing", "pending"), false);
  assert.strictEqual(canTransition("delivered_to_customer", "preparing"), false);
});

test("same-status transition rejected", () => {
  assert.strictEqual(canTransition("store_accepted", "store_accepted"), false);
  assert.strictEqual(canTransition("confirmed", "store_accepted"), false);
});

test("confirmed alias behaves like store_accepted for outgoing", () => {
  assert.strictEqual(canTransition("confirmed", "preparing"), true);
  assert.strictEqual(canTransition("confirmed", "delivered_to_driver"), true);
});

test("normalizeStatus aliases", () => {
  assert.strictEqual(normalizeStatus("confirmed"), "store_accepted");
  assert.strictEqual(normalizeStatus("delivered"), "delivered_to_customer");
  assert.strictEqual(normalizeStatus("preparing"), "preparing");
});

test("every non-terminal status has at least one outgoing transition (except delivered_to_customer)", () => {
  const terminals = new Set([
    "delivered_to_customer",
    "delivered",
    "rejected",
    "cancelled",
    "completed_off_platform",
  ]);
  for (const status of ALLOWED_STATUSES) {
    if (terminals.has(status)) {
      assert.strictEqual(
        ALLOWED_TRANSITIONS[status].size,
        0,
        `${status} should be terminal`
      );
      continue;
    }
    assert.ok(
      ALLOWED_TRANSITIONS[status]?.size > 0,
      `${status} should have outgoing transitions`
    );
  }
});

test("no transition targets an unknown status", () => {
  const known = new Set(ALLOWED_STATUSES);
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.ok(known.has(from), `unknown from-status ${from}`);
    for (const to of targets) {
      assert.ok(known.has(to), `unknown to-status ${to} from ${from}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
