/**
 * Delivery billing portal access — run with: node tests/deliveryBillingAccess.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { BILLING_STATUSES } = require("../src/constants/deliveryBilling.constants");

function buildBillingStatusPayload(openPeriodStatus) {
  const openPeriod = openPeriodStatus ? { status: openPeriodStatus } : null;
  const rejectedPeriod = openPeriodStatus === BILLING_STATUSES.PAYMENT_REJECTED ? openPeriod : null;
  const needsPayment = Boolean(openPeriod && [
    BILLING_STATUSES.AWAITING_PAYMENT,
    BILLING_STATUSES.PAYMENT_REJECTED,
  ].includes(openPeriod.status));
  const paymentPending = openPeriod?.status === BILLING_STATUSES.PAYMENT_PENDING;
  return {
    needsPayment,
    paymentPending,
    paymentRejected: Boolean(rejectedPeriod),
    canOperate: !(openPeriod && [
      BILLING_STATUSES.AWAITING_PAYMENT,
      BILLING_STATUSES.PAYMENT_REJECTED,
    ].includes(openPeriod.status)),
  };
}

function shouldBlockPortal(status) {
  return Boolean(status.needsPayment);
}

function shouldAllowBillingRoute(_status) {
  return true;
}

test("awaiting_payment blocks normal portal", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.AWAITING_PAYMENT);
  assert.equal(status.needsPayment, true);
  assert.equal(status.canOperate, false);
  assert.equal(shouldBlockPortal(status), true);
});

test("awaiting_payment allows billing page", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.AWAITING_PAYMENT);
  assert.equal(shouldAllowBillingRoute(status), true);
});

test("payment_pending allows portal", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.PAYMENT_PENDING);
  assert.equal(status.needsPayment, false);
  assert.equal(status.paymentPending, true);
  assert.equal(status.canOperate, true);
  assert.equal(shouldBlockPortal(status), false);
});

test("payment_pending shows global review banner flag", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.PAYMENT_PENDING);
  assert.equal(status.paymentPending, true);
});

test("payment_rejected blocks portal again", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.PAYMENT_REJECTED);
  assert.equal(status.needsPayment, true);
  assert.equal(status.paymentRejected, true);
  assert.equal(shouldBlockPortal(status), true);
});

test("payment_rejected allows billing page", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.PAYMENT_REJECTED);
  assert.equal(shouldAllowBillingRoute(status), true);
});

test("counting allows normal access", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.COUNTING);
  assert.equal(status.needsPayment, false);
  assert.equal(status.canOperate, true);
});

test("exempted company has normal access", () => {
  const status = buildBillingStatusPayload(BILLING_STATUSES.EXEMPTED);
  assert.equal(status.needsPayment, false);
  assert.equal(status.paymentPending, false);
  assert.equal(status.canOperate, true);
});

test("paid company has normal access", () => {
  const status = buildBillingStatusPayload(null);
  assert.equal(status.needsPayment, false);
  assert.equal(status.canOperate, true);
});

console.log("deliveryBillingAccess.test.js — all tests registered");
