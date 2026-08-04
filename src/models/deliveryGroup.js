/**
 * @deprecated Use require("./deliverySession") — kept for backward compatibility.
 * DeliveryGroup and DeliverySession share the same MongoDB collection.
 */
module.exports = require("./deliverySession");
module.exports.TRIP_STATUSES = require("../constants/deliverySession.constants").SESSION_STATUS_VALUES;
