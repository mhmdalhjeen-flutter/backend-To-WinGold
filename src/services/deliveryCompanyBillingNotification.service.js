const deliveryNotificationService = require("./deliveryNotification.service");
const { formatMonthLabel } = require("../utils/billingMonth.util");

const BILLING_URL = "/settings/billing";

function billingData(period) {
  return {
    url: BILLING_URL,
    periodId: String(period._id),
    monthKey: period.monthKey,
  };
}

async function notifyBillingRequired(companyId, period) {
  if (!companyId || !period) return;
  const monthLabel = formatMonthLabel(period.monthKey);
  const amount = Number(period.amountDue || 0);
  await deliveryNotificationService.notifyCompanyUsers(companyId, {
    type: "delivery_billing_required",
    title: "مطلوب دفع الاشتراك الشهري",
    body: `فاتورة ${monthLabel}: ${period.deliveredOrderCount} طلب — ${amount} ${period.currency || "ILS"}`,
    session: null,
    data: billingData(period),
  });
}

async function notifyBillingSubmitted(companyId, period) {
  if (!companyId || !period) return;
  const monthLabel = formatMonthLabel(period.monthKey);
  await deliveryNotificationService.notifyCompanyUsers(companyId, {
    type: "delivery_billing_submitted",
    title: "تم إرسال الدفع — قيد المراجعة",
    body: `دفع ${monthLabel} قيد مراجعة الإدارة`,
    session: null,
    data: billingData(period),
  });
}

async function notifyBillingVerified(companyId, period) {
  if (!companyId || !period) return;
  const monthLabel = formatMonthLabel(period.monthKey);
  await deliveryNotificationService.notifyCompanyUsers(companyId, {
    type: "delivery_billing_verified",
    title: "تم التحقق من الدفع",
    body: `تم اعتماد دفع ${monthLabel} — بدأت دورة الفوترة الجديدة`,
    session: null,
    data: billingData(period),
  });
}

async function notifyBillingRejected(companyId, period, reason = "") {
  if (!companyId || !period) return;
  const monthLabel = formatMonthLabel(period.monthKey);
  await deliveryNotificationService.notifyCompanyUsers(companyId, {
    type: "delivery_billing_rejected",
    title: "طلب تصحيح الدفع",
    body: reason
      ? `دفع ${monthLabel}: ${reason}`
      : `يرجى مراجعة بيانات دفع ${monthLabel} وإعادة الإرسال`,
    session: null,
    data: billingData(period),
  });
}

async function notifyBillingExempted(companyId, period) {
  if (!companyId || !period) return;
  const monthLabel = formatMonthLabel(period.monthKey);
  await deliveryNotificationService.notifyCompanyUsers(companyId, {
    type: "delivery_billing_exempted",
    title: "تم إعفاء الشركة من الدفع",
    body: `تم إعفاء ${monthLabel} — بدأت دورة الفوترة الجديدة`,
    session: null,
    data: billingData(period),
  });
}

module.exports = {
  notifyBillingRequired,
  notifyBillingSubmitted,
  notifyBillingVerified,
  notifyBillingRejected,
  notifyBillingExempted,
};
