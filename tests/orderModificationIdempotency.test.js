/**
 * Replay safety for customer order modifications —
 * run with: node tests/orderModificationIdempotency.test.js
 *
 * A modification confirmed with no connection is uploaded by the offline queue,
 * which may retry after the server already applied it. These tests pin the
 * behaviour that makes that safe: a known operation id returns the current
 * order, and an unknown one is applied and recorded.
 */
const assert = require("assert");

const Order = require("../src/models/order");
const Store = require("../src/models/store");
const modificationService = require("../src/services/orderModification.service");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function fakeOrder(overrides = {}) {
  return {
    _id: "order-1",
    orderNumber: "WZ-1001",
    customer: "cust-1",
    store: "store-1",
    status: "modification_requested",
    items: [],
    total: 100,
    appliedModificationOps: [],
    ...overrides,
  };
}

/** Swap the model lookups for fixtures, restoring them afterwards. */
async function withOrder(order, fn) {
  const originalFindOne = Order.findOne;
  const originalStore = Store.findById;

  Order.findOne = async () => order;
  Store.findById = () => ({
    select: () => ({ lean: async () => ({ _id: "store-1", name: "متجر", owner: "u1" }) }),
  });

  try {
    return await fn();
  } finally {
    Order.findOne = originalFindOne;
    Store.findById = originalStore;
  }
}

(async () => {
  console.log("\nOrder Modification Idempotency Tests\n");

  await test("a replayed operation id returns the order without re-applying", async () => {
    const order = fakeOrder({
      status: "pending",
      appliedModificationOps: ["cop_abc"],
    });

    const result = await withOrder(order, () => modificationService.resolveModification(
      "cust-1",
      "order-1",
      { action: "replace", clientOperationId: "cop_abc" }
    ));

    assert.strictEqual(result.replayed, true);
    assert.strictEqual(result.order.orderNumber, "WZ-1001");
    assert.deepStrictEqual(order.appliedModificationOps, ["cop_abc"]);
  });

  await test("the replay check runs before the status check", async () => {
    // Without the guard this order would be rejected: it already left
    // modification_requested when the first upload succeeded.
    const order = fakeOrder({
      status: "delivered",
      appliedModificationOps: ["cop_abc"],
    });

    const result = await withOrder(order, () => modificationService.resolveModification(
      "cust-1",
      "order-1",
      { action: "change_delivery", clientOperationId: "cop_abc" }
    ));

    assert.strictEqual(result.replayed, true);
  });

  await test("an unknown operation id is recorded so the next replay is caught", async () => {
    const order = fakeOrder();

    await withOrder(order, async () => {
      // Store lookup is not stubbed, so the call fails after the id is stamped.
      await modificationService
        .resolveModification("cust-1", "order-1", {
          action: "replace",
          clientOperationId: "cop_new",
        })
        .catch(() => {});
    });

    assert.deepStrictEqual(order.appliedModificationOps, ["cop_new"]);
  });

  await test("a modification without an operation id is left untracked", async () => {
    const order = fakeOrder();

    await withOrder(order, async () => {
      await modificationService
        .resolveModification("cust-1", "order-1", { action: "replace" })
        .catch(() => {});
    });

    assert.deepStrictEqual(order.appliedModificationOps, []);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
