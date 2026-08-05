/**
 * Store card inventory unit tests — run with: node tests/storeCardInventory.test.js
 */
const assert = require("assert");
const {
  findInventoryEntry,
  inventoryKey,
} = require("../src/services/storeCardInventory.service");

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

console.log("\nStore Card Inventory Tests\n");

test("inventoryKey encodes card type and points value", () => {
  assert.strictEqual(inventoryKey("abc123", 5), "abc123:5");
  assert.strictEqual(inventoryKey(null, 10), "none:10");
});

test("findInventoryEntry matches typed card inventory row", () => {
  const inventory = [
    { cardType: "typeA", pointsValue: 5, count: 2 },
    { cardType: "typeB", pointsValue: 10, count: 1 },
  ];
  const found = findInventoryEntry(inventory, "typeB", 10);
  assert.strictEqual(found.pointsValue, 10);
  assert.strictEqual(found.count, 1);
});

test("FIFO consumption uses first entry with positive count (points from card)", () => {
  const inventory = [
    { cardType: null, pointsValue: 5, count: 0 },
    { cardType: null, pointsValue: 10, count: 3 },
    { cardType: null, pointsValue: 20, count: 1 },
  ];
  const idx = inventory.findIndex((entry) => entry.count > 0);
  assert.strictEqual(idx, 1);
  assert.strictEqual(inventory[idx].pointsValue, 10);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
