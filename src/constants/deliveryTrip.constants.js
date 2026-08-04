const {
  SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  normalizeSessionStatus,
} = require("./deliverySession.constants");

/** @deprecated use SESSION_STATUSES */
const TRIP_STATUS_LABELS = SESSION_STATUS_LABELS;

/** @deprecated legacy alias map for company portal responses */
const TRIP_STATUS_COLORS = {
  [SESSION_STATUSES.WAITING]: "status-waiting",
  [SESSION_STATUSES.WAITING_FOR_STORES]: "status-waiting",
  [SESSION_STATUSES.READY_FOR_PICKUP]: "status-waiting",
  [SESSION_STATUSES.ACCEPTED]: "status-active",
  [SESSION_STATUSES.OUT_FOR_DELIVERY]: "status-way",
  [SESSION_STATUSES.COMPLETED]: "status-done",
  [SESSION_STATUSES.REJECTED]: "status-cancel",
  [SESSION_STATUSES.CANCELLED]: "status-cancel",
  waiting_for_acceptance: "status-waiting",
  driver_assigned: "status-active",
  accepted: "status-active",
  collecting_orders: "status-way",
  on_delivery: "status-way",
  on_the_way: "status-way",
  delivered: "status-done",
};

const ACTIVE_TRIP_STATUSES = new Set([
  SESSION_STATUSES.ACCEPTED,
  SESSION_STATUSES.OUT_FOR_DELIVERY,
  "driver_assigned",
  "collecting_orders",
  "on_delivery",
  "on_the_way",
]);

const NEW_TRIP_STATUSES = new Set([
  SESSION_STATUSES.READY_FOR_PICKUP,
  "waiting_for_acceptance",
]);

const COMPLETED_TRIP_STATUSES = new Set([
  SESSION_STATUSES.COMPLETED,
  "delivered",
]);

const STORE_STOP_READY_STATUSES = new Set([
  "store_accepted",
  "preparing",
  "delivered_to_driver",
  "confirmed",
]);

module.exports = {
  TRIP_STATUS_LABELS,
  TRIP_STATUS_COLORS,
  ACTIVE_TRIP_STATUSES,
  NEW_TRIP_STATUSES,
  COMPLETED_TRIP_STATUSES,
  STORE_STOP_READY_STATUSES,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  normalizeSessionStatus,
};
