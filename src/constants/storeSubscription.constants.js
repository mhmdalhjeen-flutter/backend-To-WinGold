const SUBSCRIPTION_STATUSES = Object.freeze({
  COUNTING: "counting",
  AWAITING_PAYMENT: "awaiting_payment",
  ACTIVE: "active",
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_REJECTED: "payment_rejected",
  EXEMPTED: "exempted",
});

const CLOSED_SUBSCRIPTION_STATUSES = Object.freeze([
  SUBSCRIPTION_STATUSES.ACTIVE,
  SUBSCRIPTION_STATUSES.EXEMPTED,
]);

const OPEN_SUBSCRIPTION_STATUSES = Object.freeze([
  SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
  SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
  SUBSCRIPTION_STATUSES.PAYMENT_REJECTED,
]);

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
  CLOSED_SUBSCRIPTION_STATUSES,
  OPEN_SUBSCRIPTION_STATUSES,
  CARD_SOURCES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
  SUBSCRIPTION_PAYMENT_METHOD_TYPES,
};
