const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePushTargetApp,
  resolveCustomerPushUrl,
} = require("../src/utils/pushTarget.util");

test("resolvePushTargetApp routes customer order notifications to customer app", () => {
  assert.equal(resolvePushTargetApp("order_confirmed"), "customer");
  assert.equal(resolvePushTargetApp("order_rejected"), "customer");
  assert.equal(resolvePushTargetApp("delivery_on_the_way"), "customer");
});

test("resolvePushTargetApp routes store offer notifications to store app", () => {
  assert.equal(resolvePushTargetApp("offer_expired"), "store");
  assert.equal(resolvePushTargetApp("delivery_order_included"), "store");
});

test("resolvePushTargetApp skips driver/company-only delivery portal notifications", () => {
  assert.equal(resolvePushTargetApp("delivery_assigned_to_you"), null);
  assert.equal(resolvePushTargetApp("delivery_new_request"), null);
});

test("resolveCustomerPushUrl builds order deep links", () => {
  assert.equal(
    resolveCustomerPushUrl("order_confirmed", { orderId: "abc123" }),
    "/orders/abc123"
  );
  assert.equal(
    resolveCustomerPushUrl("order_modification_requested", { orderId: "abc123" }),
    "/orders/abc123/modify"
  );
});

test("resolveCustomerPushUrl preserves explicit relative urls", () => {
  assert.equal(resolveCustomerPushUrl("general", { url: "/center" }), "/center");
});
