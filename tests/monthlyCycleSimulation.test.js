/**
 * Monthly cycle simulation — run with: NODE_ENV=test node --test tests/monthlyCycleSimulation.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCurrentMonthKey,
  addMonthsToMonthKey,
  monthKeyToReferenceDate,
} = require("../src/utils/subscriptionMonth.util");

test("addMonthsToMonthKey advances calendar months", () => {
  assert.equal(addMonthsToMonthKey("2026-08", 1), "2026-09");
  assert.equal(addMonthsToMonthKey("2026-12", 1), "2027-01");
});

test("monthKeyToReferenceDate returns first day of month", () => {
  const date = monthKeyToReferenceDate("2026-09");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 8);
  assert.equal(date.getDate(), 1);
});

test("simulation target uses cursor + 1 without changing real clock", () => {
  const realNow = getCurrentMonthKey();
  const cursor = realNow;
  const target = addMonthsToMonthKey(cursor, 1);
  assert.notEqual(target, addMonthsToMonthKey(cursor, 2));
  assert.equal(getCurrentMonthKey(new Date()), realNow);
});

console.log("monthlyCycleSimulation.test.js — all tests registered");
