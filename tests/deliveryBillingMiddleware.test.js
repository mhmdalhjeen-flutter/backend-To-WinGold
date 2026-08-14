/**
 * Delivery billing middleware — run with: node tests/deliveryBillingMiddleware.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const billingService = require("../src/services/deliveryCompanyBilling.service");
const { requireDeliveryBillingAccess } = require("../src/middleware/deliveryBilling.middleware");

const originalGetStatus = billingService.getCompanyBillingStatus;

function mockReq(path, companyId = "company-1") {
  return {
    path,
    originalUrl: `/delivery${path}`,
    userDoc: { deliveryCompanyId: companyId },
    user: { deliveryCompanyId: companyId },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test.after(() => {
  billingService.getCompanyBillingStatus = originalGetStatus;
});

test("middleware blocks non-billing routes when needsPayment", async () => {
  billingService.getCompanyBillingStatus = async () => ({
    needsPayment: true,
    paymentRejected: false,
    billingStatus: "awaiting_payment",
  });
  const req = mockReq("/company/dashboard/stats");
  const res = mockRes();
  let nextCalled = false;
  await requireDeliveryBillingAccess(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "billing_payment_required");
});

test("middleware allows billing routes when needsPayment", async () => {
  billingService.getCompanyBillingStatus = async () => ({
    needsPayment: true,
    paymentRejected: false,
    billingStatus: "awaiting_payment",
  });
  const req = mockReq("/company/billing");
  const res = mockRes();
  let nextCalled = false;
  await requireDeliveryBillingAccess(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("middleware allows portal when paymentPending", async () => {
  billingService.getCompanyBillingStatus = async () => ({
    needsPayment: false,
    paymentPending: true,
    paymentRejected: false,
    billingStatus: "payment_pending",
  });
  const req = mockReq("/company/requests");
  const res = mockRes();
  let nextCalled = false;
  await requireDeliveryBillingAccess(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

console.log("deliveryBillingMiddleware.test.js — all tests registered");
