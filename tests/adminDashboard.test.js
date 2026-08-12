/**
 * Admin dashboard breakdown unit tests — run with: node tests/adminDashboard.test.js
 */
const assert = require("assert");
const {
  groupUsersByMainRegion,
  buildOrderTimelineWithMonths,
  LOCATION_NOT_SPECIFIED,
} = require("../src/services/adminDashboard.service");

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

console.log("\nAdmin Dashboard Service Tests\n");

test("groups users by main region and rolls up sub-regions", () => {
  const regions = [
    { _id: "north", name: "North", parent: null },
    { _id: "gaza", name: "Gaza", parent: null },
    { _id: "north-sub", name: "Sheikh Radwan", parent: "north" },
  ];
  const rows = [
    { _id: "north-sub", count: 50 },
    { _id: "north", count: 150 },
    { _id: "gaza", count: 300 },
  ];

  const groups = groupUsersByMainRegion(rows, regions);
  const north = groups.find((g) => g.region === "North");
  const gaza = groups.find((g) => g.region === "Gaza");

  assert.strictEqual(north.count, 200);
  assert.strictEqual(gaza.count, 300);
});

test("uses Location not specified for unknown regions", () => {
  const groups = groupUsersByMainRegion([{ _id: "missing", count: 5 }], []);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].region, LOCATION_NOT_SPECIFIED);
  assert.strictEqual(groups[0].count, 5);
});

test("buildOrderTimelineWithMonths inserts month summary after last day of month", () => {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const d0 = new Date(end);
  const d1 = new Date(end);
  d1.setDate(end.getDate() - 1);
  const d2 = new Date(end);
  d2.setDate(end.getDate() - 2);

  const key0 = d0.toISOString().slice(0, 10);
  const key1 = d1.toISOString().slice(0, 10);
  const key2 = d2.toISOString().slice(0, 10);

  const rows = [
    { _id: key0, count: 15 },
    { _id: key1, count: 20 },
    { _id: key2, count: 10 },
  ];

  const items = buildOrderTimelineWithMonths(rows, 3);
  const dayItems = items.filter((i) => i.type === "day");
  const monthItems = items.filter((i) => i.type === "monthSummary");

  assert.strictEqual(dayItems.length, 3);
  assert.ok(monthItems.length >= 1);

  const monthKey = key0.slice(0, 7);
  const monthSummary = monthItems.find((m) => m.month === monthKey);
  assert.ok(monthSummary);
  assert.strictEqual(monthSummary.totalDelivered, 15 + 20 + (key2.slice(0, 7) === monthKey ? 10 : 0));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
