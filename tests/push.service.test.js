const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePushTargetApp,
  resolveCustomerPushUrl,
  resolveStorePushUrl,
  resolveDeliveryPushUrl,
  resolvePushUrl,
  VALID_PUSH_APPS,
  isCustomerPushAllowed,
} = require("../src/utils/pushTarget.util");

test("VALID_PUSH_APPS includes all four PWAs", () => {
  assert.equal(VALID_PUSH_APPS.has("customer"), true);
  assert.equal(VALID_PUSH_APPS.has("store"), true);
  assert.equal(VALID_PUSH_APPS.has("admin"), true);
  assert.equal(VALID_PUSH_APPS.has("delivery"), true);
});

test("resolvePushTargetApp routes customer order notifications to customer app", () => {
  assert.equal(resolvePushTargetApp("order_confirmed"), "customer");
  assert.equal(resolvePushTargetApp("order_rejected"), "customer");
  assert.equal(resolvePushTargetApp("delivery_on_the_way"), "customer");
});

test("isCustomerPushAllowed limits customer Web Push to required events", () => {
  assert.equal(isCustomerPushAllowed("store_new_product"), true);
  assert.equal(isCustomerPushAllowed("order_confirmed"), true);
  assert.equal(isCustomerPushAllowed("delivery_on_the_way"), true);
  assert.equal(isCustomerPushAllowed("order_delivered"), true);
  assert.equal(isCustomerPushAllowed("delivery_driver_assigned"), false);
  assert.equal(isCustomerPushAllowed("referral_batch"), false);
  assert.equal(isCustomerPushAllowed("order_rejected"), false);
});

test("resolvePushTargetApp routes store offer notifications to store app", () => {
  assert.equal(resolvePushTargetApp("offer_expired"), "store");
  assert.equal(resolvePushTargetApp("delivery_order_included"), "store");
});

test("resolvePushTargetApp respects explicit pushApp override", () => {
  assert.equal(
    resolvePushTargetApp("delivery_waiting_stores", { pushApp: "delivery" }),
    "delivery",
  );
  assert.equal(
    resolvePushTargetApp("delivery_waiting_stores", { pushApp: "customer" }),
    "customer",
  );
  assert.equal(
    resolvePushTargetApp("order_modification_resolved", { pushApp: "store" }),
    "store",
  );
});

test("resolvePushTargetApp routes delivery portal types to delivery app", () => {
  assert.equal(resolvePushTargetApp("delivery_assigned_to_you"), "delivery");
  assert.equal(resolvePushTargetApp("delivery_new_request"), "delivery");
  assert.equal(resolvePushTargetApp("delivery_out_for_delivery"), "delivery");
});

test("resolveCustomerPushUrl builds order deep links", () => {
  assert.equal(
    resolveCustomerPushUrl("order_confirmed", { orderId: "abc123" }),
    "/orders/abc123",
  );
  assert.equal(
    resolveCustomerPushUrl("delivery_session_created", { deliverySessionId: "sess1" }),
    "/delivery/confirm?session=sess1",
  );
});

test("resolveStorePushUrl builds store order deep links", () => {
  assert.equal(
    resolveStorePushUrl("delivery_order_included", { orderId: "ord1" }),
    "/store/orders/ord1",
  );
  assert.equal(
    resolveStorePushUrl("order_modification_resolved", { orderId: "ord1" }),
    "/store/orders/ord1",
  );
});

test("resolveDeliveryPushUrl builds company and driver deep links", () => {
  assert.equal(
    resolveDeliveryPushUrl("delivery_new_request", { deliverySessionId: "sess1" }),
    "/requests/sess1",
  );
  assert.equal(
    resolveDeliveryPushUrl("delivery_assigned_to_you", { deliverySessionId: "sess1" }),
    "/driver/delivery/sess1",
  );
});

test("resolvePushUrl selects app-specific paths", () => {
  assert.equal(
    resolvePushUrl("delivery", "delivery_waiting_stores", { deliverySessionId: "s1" }),
    "/requests/s1",
  );
  assert.equal(
    resolvePushUrl("admin", "push_test", {}),
    "/dashboard",
  );
});

test("resolveDeliveryPushUrl builds driver chat deep links", () => {
  assert.equal(
    resolveDeliveryPushUrl("chat_message", {
      senderId: "user1",
      recipientRole: "delivery_driver",
    }),
    "/driver/chat/user1",
  );
  assert.equal(
    resolveDeliveryPushUrl("chat_message", {
      senderId: "user1",
      recipientRole: "delivery_company",
    }),
    "/chat/user1",
  );
});

test("shared delivery_waiting_stores routes to delivery portal by default", () => {
  assert.equal(resolvePushTargetApp("delivery_waiting_stores"), "delivery");
  assert.equal(
    resolvePushTargetApp("delivery_waiting_stores", { pushApp: "customer" }),
    "customer",
  );
});
