/**
 * Admin delivery billing read path — run with: node tests/adminDeliveryBillingRead.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliveryCompanyBillingPeriod = require("../src/models/deliveryCompanyBillingPeriod");
const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");
const DeliverySession = require("../src/models/deliverySession");

const { BILLING_STATUSES, DEFAULT_PRICE_PER_ORDER } = require("../src/constants/deliveryBilling.constants");
const { getCurrentMonthKey } = require("../src/utils/subscriptionMonth.util");
const { listAdminBillingCards } = require("../src/services/deliveryCompanyBilling.service");
const { toAdminCompany } = require("../src/services/deliveryCompany.service");

require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRequired = async () => {};

const companyA = new mongoose.Types.ObjectId();
const companyB = new mongoose.Types.ObjectId();
const order1 = new mongoose.Types.ObjectId();
const order2 = new mongoose.Types.ObjectId();
const handoverAt = new Date("2026-08-15T10:00:00Z");
const monthKey = "2026-08";

const companies = new Map();
const periods = new Map();
const handovers = [];

function resetState() {
  companies.clear();
  periods.clear();
  handovers.length = 0;

  companies.set(String(companyA), {
    _id: companyA,
    name: "Company A",
    phone: "0599000001",
    isActive: true,
    pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    handedOverOrderCount: 0,
    deletedAt: null,
  });
  companies.set(String(companyB), {
    _id: companyB,
    name: "Company B",
    phone: "0599000002",
    isActive: true,
    pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    handedOverOrderCount: 0,
    deletedAt: null,
  });

  handovers.push({
    _id: new mongoose.Types.ObjectId(),
    order: order1,
    deliveryCompany: companyA,
    handoverAt,
    billingCountApplied: true,
  });
}

DeliveryCompany.find = (query) => ({
  select: () => ({
    sort: () => ({
      lean: async () => Array.from(companies.values()).filter((c) => !c.deletedAt),
    }),
  }),
});

DeliveryCompanyBillingPeriod.find = (query) => ({
  lean: async () => {
    const rows = Array.from(periods.values());
    if (query.deliveryCompany?.$in) {
      return rows.filter((p) => query.deliveryCompany.$in.some((id) => String(id) === String(p.deliveryCompany)));
    }
    return rows;
  },
});

DeliveryCompanyOrderHandover.aggregate = async (pipeline) => {
  const matchStage = pipeline.find((stage) => stage.$match);
  const match = matchStage?.$match || {};
  let rows = [...handovers];
  if (match.deliveryCompany?.$in) {
    rows = rows.filter((h) => match.deliveryCompany.$in.some((id) => String(id) === String(h.deliveryCompany)));
  }
  if (match.handoverAt?.$gte || match.handoverAt?.$lt) {
    rows = rows.filter((h) => {
      const at = new Date(h.handoverAt).getTime();
      if (match.handoverAt.$gte && at < new Date(match.handoverAt.$gte).getTime()) return false;
      if (match.handoverAt.$lt && at >= new Date(match.handoverAt.$lt).getTime()) return false;
      return true;
    });
  }
  const groupStage = pipeline.find((stage) => stage.$group);
  if (!groupStage) return rows;
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.deliveryCompany);
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  return Array.from(grouped.entries()).map(([_id, count]) => ({ _id, count }));
};

DeliveryCompanyOrderHandover.find = () => ({
  select: () => ({
    lean: async () => [],
  }),
});

DeliveryCompanyOrderHandover.countDocuments = async () => 0;

DeliverySession.aggregate = async () => [];

test.beforeEach(() => {
  resetState();
  periods.set(`${String(companyA)}:${monthKey}`, {
    _id: new mongoose.Types.ObjectId(),
    deliveryCompany: companyA,
    monthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: 0,
    currency: "ILS",
    closedAt: null,
  });
});

test("listAdminBillingCards reflects handover records when billing period counter is stale", async () => {
  const payload = await listAdminBillingCards(handoverAt);
  const cardA = payload.cards.find((row) => String(row.company._id) === String(companyA));
  const cardB = payload.cards.find((row) => String(row.company._id) === String(companyB));

  assert.equal(cardA.currentMonthOrderCount, 1);
  assert.equal(cardA.currentPeriod.deliveredOrderCount, 1);
  assert.equal(cardB.currentMonthOrderCount, 0);
  assert.equal(periods.get(`${String(companyA)}:${monthKey}`).deliveredOrderCount, 0);
});

test("toAdminCompany can display lifetime handover count from authoritative source", () => {
  const company = companies.get(String(companyA));
  const admin = toAdminCompany(company, [], { handedOverOrderCount: 1 });
  assert.equal(admin.handedOverOrderCount, 1);
  assert.equal(company.handedOverOrderCount, 0);
});

test("company isolation: only company A receives the handover count", async () => {
  handovers.push({
    _id: new mongoose.Types.ObjectId(),
    order: order2,
    deliveryCompany: companyB,
    handoverAt,
    billingCountApplied: true,
  });
  periods.set(`${String(companyB)}:${monthKey}`, {
    _id: new mongoose.Types.ObjectId(),
    deliveryCompany: companyB,
    monthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: 0,
    currency: "ILS",
    closedAt: null,
  });

  const payload = await listAdminBillingCards(handoverAt);
  const cardA = payload.cards.find((row) => String(row.company._id) === String(companyA));
  const cardB = payload.cards.find((row) => String(row.company._id) === String(companyB));

  assert.equal(cardA.currentMonthOrderCount, 1);
  assert.equal(cardB.currentMonthOrderCount, 1);
});

test.after(() => {
  setTimeout(() => process.exit(0), 50);
});

console.log("adminDeliveryBillingRead.test.js — all tests registered");
