const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReservationAnswers,
  defaultReservationSettings,
  isReservationEnabled,
  normalizeReservationSettings,
} = require("../src/utils/reservationSettings.util");
const { resolveCustomerPushUrl, resolveStorePushUrl, resolvePushTargetApp } = require("../src/utils/pushTarget.util");

test("normalizeReservationSettings defaults when omitted", () => {
  assert.deepEqual(normalizeReservationSettings(null), defaultReservationSettings());
  assert.equal(normalizeReservationSettings(undefined).enabled, false);
  assert.equal(normalizeReservationSettings({}).enabled, false);
});

test("normalizeReservationSettings keeps configured fields when disabled", () => {
  const settings = normalizeReservationSettings({
    enabled: false,
    fields: [{ id: "f1", label: "الاسم", type: "text", required: true, order: 0 }],
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.fields.length, 1);
  assert.equal(settings.fields[0].label, "الاسم");
});

test("normalizeReservationSettings maps long text to textarea", () => {
  const settings = normalizeReservationSettings({
    enabled: true,
    fields: [{ id: "notes", label: "ملاحظات", type: "long_text", required: false }],
  });
  assert.equal(settings.fields[0].type, "textarea");
});

test("isReservationEnabled requires explicit true", () => {
  assert.equal(isReservationEnabled(null), false);
  assert.equal(isReservationEnabled({ enabled: false }), false);
  assert.equal(isReservationEnabled({ enabled: true }), true);
});

test("buildReservationAnswers rejects submissions when reservations are disabled", () => {
  assert.throws(
    () => buildReservationAnswers({ enabled: false, fields: [] }, []),
    (err) => err.status === 400,
  );
});

test("buildReservationAnswers requires configured required fields", () => {
  const settings = normalizeReservationSettings({
    enabled: true,
    fields: [
      { id: "name", label: "الاسم", type: "text", required: true, order: 0 },
      { id: "notes", label: "ملاحظات", type: "textarea", required: false, order: 1 },
    ],
  });
  assert.throws(
    () => buildReservationAnswers(settings, [{ fieldId: "notes", value: "hello" }]),
    (err) => err.status === 400 && /الاسم/.test(err.message),
  );
});

test("buildReservationAnswers allows empty optional fields and preserves labels", () => {
  const settings = normalizeReservationSettings({
    enabled: true,
    fields: [
      { id: "name", label: "الاسم", type: "text", required: true, order: 0 },
      { id: "notes", label: "ملاحظات", type: "textarea", required: false, order: 1 },
    ],
  });
  const answers = buildReservationAnswers(settings, [{ fieldId: "name", value: "أحمد" }]);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].label, "الاسم");
  assert.equal(answers[0].value, "أحمد");
  assert.equal(answers[1].label, "ملاحظات");
  assert.equal(answers[1].value, "");
});

test("buildReservationAnswers rejects undeclared fields", () => {
  const settings = normalizeReservationSettings({
    enabled: true,
    fields: [{ id: "name", label: "الاسم", type: "text", required: true }],
  });
  assert.throws(
    () => buildReservationAnswers(settings, [
      { fieldId: "name", value: "أحمد" },
      { fieldId: "secret", value: "x" },
    ]),
    (err) => err.status === 400,
  );
});

test("reservation notification URLs target store and customer apps", () => {
  assert.equal(resolvePushTargetApp("store_new_reservation"), "store");
  assert.equal(resolveStorePushUrl("store_new_reservation", {}), "/store/reservations");
  assert.equal(resolvePushTargetApp("reservation_accepted"), "customer");
  assert.equal(
    resolveCustomerPushUrl("reservation_accepted", { itemId: "p1", itemType: "Product" }),
    "/product/p1",
  );
  assert.equal(
    resolveCustomerPushUrl("reservation_rejected", { itemId: "o1", itemType: "Offer" }),
    "/offer/o1",
  );
});
