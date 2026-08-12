const DeliveryCompanyOrderHandover = require("../models/deliveryCompanyOrderHandover");
const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const Order = require("../models/order");
const notificationService = require("../services/notification.service");
const { handoverNeedsDriverReview } = require("../services/deliveryCompanyHandover.service");
const { safeLog } = require("./logSanitize.util");

const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Sends lightweight reminders to drivers who have not confirmed delivery
 * 24+ hours after the store handed the order over.
 */
async function monitorDriverConfirmations() {
  try {
    const cutoff = new Date(Date.now() - REMINDER_AFTER_MS);
    const pending = await DeliveryCompanyOrderHandover.find({
      driverConfirmedAt: null,
      driverConfirmationReminderSent: false,
      handoverAt: { $lte: cutoff },
      assignedDriverId: { $ne: null },
    })
      .select("_id order assignedDriverId handoverAt")
      .limit(100)
      .lean();

    if (!pending.length) return;

    const orderIds = pending.map((h) => h.order);
    const orders = await Order.find({ _id: { $in: orderIds } })
      .select("orderNumber status deliveryGroup")
      .lean();
    const orderMap = new Map(orders.map((o) => [String(o._id), o]));

    const driverIds = [...new Set(pending.map((h) => String(h.assignedDriverId)))];
    const drivers = await DeliveryCompanyDriver.find({ _id: { $in: driverIds } })
      .select("userId name")
      .lean();
    const driverMap = new Map(drivers.map((d) => [String(d._id), d]));

    let sent = 0;
    for (const handover of pending) {
      const order = orderMap.get(String(handover.order));
      if (!order || !handoverNeedsDriverReview(handover, order.status)) {
        await DeliveryCompanyOrderHandover.updateOne(
          { _id: handover._id },
          { $set: { driverConfirmationReminderSent: true } },
        );
        continue;
      }

      const driver = driverMap.get(String(handover.assignedDriverId));
      if (!driver?.userId) continue;

      const orderRef = order.orderNumber || String(handover.order).slice(-6);
      await notificationService.create({
        user: driver.userId,
        type: "driver_delivery_unconfirmed",
        title: "تأكيد التسليم مطلوب",
        body: `الطلب #${orderRef} لم يُؤكَّد بعد. يرجى تأكيد التسليم.`,
        data: {
          orderId: String(handover.order),
          sessionId: order.deliveryGroup ? String(order.deliveryGroup) : undefined,
          handoverId: String(handover._id),
        },
      });

      await DeliveryCompanyOrderHandover.updateOne(
        { _id: handover._id },
        { $set: { driverConfirmationReminderSent: true } },
      );
      sent += 1;
    }

    if (sent > 0) {
      safeLog("info", "driver_confirmation_reminders_sent", { count: sent });
    }
  } catch (error) {
    safeLog("error", "driver_confirmation_monitor_failed", { message: error.message });
  }
}

module.exports = { monitorDriverConfirmations };
