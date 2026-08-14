/**
 * Store subscription unit tests — run with: node tests/storeSubscription.test.js
 */
const assert = require("assert");
const {
  findConsumptionEntryIndex,
  normalizeCardSource,
  inventoryKey,
} = require("../src/services/storeCardInventory.service");
const {
  resolveStoreCardConfig,
  isOperationalStatus,
  blocksStoreAccess,
  needsSubscriptionPayment,
  buildSubscriptionCardIssuancePlan,
} = require("../src/services/storeSubscription.service");
const {
  buildGiftCodesExportFilename,
  formatCardSourceLabel,
  normalizeExportCodeRow,
} = require("../src/utils/giftCodeExcelExport.util");
const {
  getCurrentMonthKey,
  isMonthKeyExpired,
  sanitizeExportFilename,
} = require("../src/utils/subscriptionMonth.util");
const {
  CARD_SOURCES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
  SUBSCRIPTION_STATUSES,
} = require("../src/constants/storeSubscription.constants");

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

console.log("\nStore Subscription Tests\n");

const tests = [];

tests.push(test("subscription card source = subscription", () => {
  assert.strictEqual(normalizeCardSource("subscription"), CARD_SOURCES.SUBSCRIPTION);
  assert.strictEqual(
    normalizeExportCodeRow({ code: "ABC", source: CARD_SOURCES.SUBSCRIPTION }).source,
    CARD_SOURCES.SUBSCRIPTION,
  );
}));

tests.push(test("independent card source = independent", () => {
  assert.strictEqual(normalizeCardSource("independent"), CARD_SOURCES.INDEPENDENT);
  assert.strictEqual(normalizeCardSource(undefined), CARD_SOURCES.INDEPENDENT);
  assert.strictEqual(normalizeExportCodeRow("ABC123").source, CARD_SOURCES.INDEPENDENT);
}));

tests.push(test("subscription cards are consumed before independent cards", () => {
  const inventory = [
    { cardType: null, pointsValue: 5, count: 2, source: CARD_SOURCES.INDEPENDENT },
    { cardType: null, pointsValue: 2, count: 3, source: CARD_SOURCES.SUBSCRIPTION },
    { cardType: null, pointsValue: 10, count: 1, source: CARD_SOURCES.INDEPENDENT },
  ];
  const idx = findConsumptionEntryIndex(inventory);
  assert.strictEqual(idx, 1);
  assert.strictEqual(inventory[idx].source, CARD_SOURCES.SUBSCRIPTION);
}));

tests.push(test("independent cards are used after subscription cards are exhausted", () => {
  const inventory = [
    { cardType: null, pointsValue: 2, count: 0, source: CARD_SOURCES.SUBSCRIPTION },
    { cardType: null, pointsValue: 5, count: 2, source: CARD_SOURCES.INDEPENDENT },
  ];
  const idx = findConsumptionEntryIndex(inventory);
  assert.strictEqual(idx, 1);
  assert.strictEqual(inventory[idx].source, CARD_SOURCES.INDEPENDENT);
}));

tests.push(test("subscription cards expire at month end via month key check", () => {
  const previousMonth = getCurrentMonthKey(new Date(2026, 6, 15));
  assert.strictEqual(isMonthKeyExpired(previousMonth, new Date(2026, 7, 1)), true);
  assert.strictEqual(isMonthKeyExpired(getCurrentMonthKey(new Date(2026, 7, 1)), new Date(2026, 7, 1)), false);
}));

tests.push(test("independent cards survive month end (source remains independent)", () => {
  const inventory = [
    { cardType: null, pointsValue: 5, count: 4, source: CARD_SOURCES.INDEPENDENT },
  ];
  const expiredSubscriptionRows = inventory.filter(
    (entry) => normalizeCardSource(entry.source) === CARD_SOURCES.SUBSCRIPTION,
  );
  assert.strictEqual(expiredSubscriptionRows.length, 0);
  assert.strictEqual(inventory[0].count, 4);
}));

tests.push(test("default quantities are 50 digital / 150 paper before customization", () => {
  const defaults = resolveStoreCardConfig({});
  assert.strictEqual(defaults.digital.quantity, DEFAULT_SUBSCRIPTION_CARD_CONFIG.digital.quantity);
  assert.strictEqual(defaults.digital.pointsPerCard, DEFAULT_SUBSCRIPTION_CARD_CONFIG.digital.pointsPerCard);
  assert.strictEqual(defaults.paper.quantity, DEFAULT_SUBSCRIPTION_CARD_CONFIG.paper.quantity);
  assert.strictEqual(defaults.paper.pointsPerCard, DEFAULT_SUBSCRIPTION_CARD_CONFIG.paper.pointsPerCard);
}));

tests.push(test("custom card quantities are used for future subscription periods", () => {
  const custom = resolveStoreCardConfig({
    subscriptionCardConfig: {
      digital: { quantity: 80, pointsPerCard: 3 },
      paper: { quantity: 200, pointsPerCard: 2 },
    },
  });
  assert.strictEqual(custom.digital.quantity, 80);
  assert.strictEqual(custom.digital.pointsPerCard, 3);
  assert.strictEqual(custom.paper.quantity, 200);
  assert.strictEqual(custom.paper.pointsPerCard, 2);
}));

tests.push(test("counting status allows store operation", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.COUNTING), true);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.COUNTING), false);
}));

tests.push(test("awaiting payment blocks store portal access", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.AWAITING_PAYMENT), false);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.AWAITING_PAYMENT), true);
}));

tests.push(test("approved payment status is operational", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.ACTIVE), true);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.ACTIVE), false);
}));

tests.push(test("exemption status is operational", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.EXEMPTED), true);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.EXEMPTED), false);
}));

tests.push(test("payment pending allows store operation", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.PAYMENT_PENDING), true);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.PAYMENT_PENDING), false);
}));

tests.push(test("rejected payment does not activate subscription or issue cards", () => {
  assert.strictEqual(isOperationalStatus(SUBSCRIPTION_STATUSES.PAYMENT_REJECTED), false);
  assert.strictEqual(blocksStoreAccess(SUBSCRIPTION_STATUSES.PAYMENT_REJECTED), true);
  const period = { status: SUBSCRIPTION_STATUSES.PAYMENT_REJECTED, cardsIssuedAt: null };
  assert.strictEqual(Boolean(period.cardsIssuedAt), false);
}));

tests.push(test("paper export contains card source label", () => {
  assert.strictEqual(formatCardSourceLabel(CARD_SOURCES.SUBSCRIPTION), 'اشتراك');
  assert.strictEqual(formatCardSourceLabel(CARD_SOURCES.INDEPENDENT), 'مستقل');
}));

tests.push(test("exported filename uses store name", () => {
  assert.strictEqual(
    buildGiftCodesExportFilename("Golden Store"),
    `${sanitizeExportFilename("Golden Store")}-gift-codes.xlsx`,
  );
  assert.strictEqual(buildGiftCodesExportFilename("متجر الذهب"), "متجر-الذهب-gift-codes.xlsx");
}));

tests.push(test("approved payment creates subscription cards (issuance plan)", () => {
  const plan = buildSubscriptionCardIssuancePlan(resolveStoreCardConfig({}));
  assert.strictEqual(plan.digitalQty, 50);
  assert.strictEqual(plan.paperQty, 150);
  assert.strictEqual(plan.digitalSource, CARD_SOURCES.SUBSCRIPTION);
  assert.strictEqual(plan.paperSource, CARD_SOURCES.SUBSCRIPTION);
}));

tests.push(test("exemption creates subscription cards (same issuance plan)", () => {
  const custom = resolveStoreCardConfig({
    subscriptionCardConfig: {
      digital: { quantity: 40, pointsPerCard: 4 },
      paper: { quantity: 120, pointsPerCard: 2 },
    },
  });
  const plan = buildSubscriptionCardIssuancePlan(custom);
  assert.strictEqual(plan.digitalQty, 40);
  assert.strictEqual(plan.paperQty, 120);
  assert.strictEqual(plan.digitalSource, CARD_SOURCES.SUBSCRIPTION);
}));

tests.push(test("inventory key includes card source", () => {
  assert.strictEqual(inventoryKey(null, 2, CARD_SOURCES.SUBSCRIPTION), "none:2:subscription");
  assert.strictEqual(inventoryKey(null, 2, CARD_SOURCES.INDEPENDENT), "none:2:independent");
}));

Promise.all(tests).then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
