const SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE: "active",
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_REJECTED: "payment_rejected",
  EXEMPTED: "exempted",
});

const CARD_SOURCES = Object.freeze({
  SUBSCRIPTION: "subscription",
  INDEPENDENT: "independent",
});

const DEFAULT_SUBSCRIPTION_CARD_CONFIG = Object.freeze({
  digital: { quantity: 50, pointsPerCard: 2 },
  paper: { quantity: 150, pointsPerCard: 1 },
});

const SUBSCRIPTION_PAYMENT_METHOD_TYPES = Object.freeze([
  "bank_palestine",
  "palpay",
  "jawwal_pay",
]);

module.exports = {
  SUBSCRIPTION_STATUSES,
  CARD_SOURCES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
  SUBSCRIPTION_PAYMENT_METHOD_TYPES,
};
