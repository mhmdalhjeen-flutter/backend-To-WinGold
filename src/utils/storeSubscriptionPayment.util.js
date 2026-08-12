const { cleanString } = require("./inputSecurity.util");
const { processOptionalImage } = require("./imageProcess.util");
const { normalizePaymentType, isValidPaymentType } = require("./paymentMethodTypes.util");
const { SUBSCRIPTION_PAYMENT_METHOD_TYPES } = require("../constants/storeSubscription.constants");

function parseSubscriptionTransferInformation(body = {}) {
  const transferRaw = body.transferInformation || body.transferDetails || {};
  return {
    senderName: cleanString(body.transferName || transferRaw.senderName, { field: "senderName", max: 120 }) || "",
    contactNumber: cleanString(body.transferPhone || transferRaw.contactNumber, { field: "contactNumber", max: 32 }) || "",
    referenceNumber: cleanString(body.transferNumber || transferRaw.referenceNumber, { field: "referenceNumber", max: 64 }) || "",
    note: cleanString(body.paymentNotes || transferRaw.note, { field: "note", max: 500 }) || "",
  };
}

function hasTransferDetails(transferInformation = {}) {
  return Boolean(
    String(transferInformation.senderName || "").trim()
    || String(transferInformation.contactNumber || "").trim()
    || String(transferInformation.referenceNumber || "").trim()
  );
}

async function parseSubscriptionPaymentSubmission(body = {}) {
  const paymentMethod = normalizePaymentType(cleanString(body.paymentMethod, { field: "paymentMethod", max: 40 }));
  if (!paymentMethod || !SUBSCRIPTION_PAYMENT_METHOD_TYPES.includes(paymentMethod)) {
    const err = new Error("طريقة الدفع غير مدعومة");
    err.status = 400;
    throw err;
  }

  const transferInformation = parseSubscriptionTransferInformation(body);
  const paymentProofRaw = body.paymentProof || body.paymentProofImage || "";
  const paymentProof = paymentProofRaw
    ? await processOptionalImage(paymentProofRaw, { maxWidth: 1600, enforceCloudinaryHttps: true })
    : "";

  if (!paymentProof && !hasTransferDetails(transferInformation)) {
    const err = new Error("يرجى رفع إشعار الدفع أو إدخال بيانات التحويل");
    err.status = 400;
    throw err;
  }

  return {
    paymentMethod,
    transferInformation,
    paymentProof,
    paymentProofImage: paymentProof,
  };
}

function serializePaymentForOwner(period) {
  if (!period) return null;
  const paymentMethod = period.paymentMethod ? String(period.paymentMethod).trim() : "";
  return {
    paymentMethod: paymentMethod || null,
    transferInformation: period.transferInformation || {},
    paymentProof: period.paymentProof || "",
    paymentProofImage: period.paymentProofImage || period.paymentProof || "",
    rejectionReason: period.rejectionReason || "",
  };
}

module.exports = {
  parseSubscriptionTransferInformation,
  hasTransferDetails,
  parseSubscriptionPaymentSubmission,
  serializePaymentForOwner,
};
