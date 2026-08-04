const DeliveryCompany = require("../models/deliveryCompany");
const { requireObjectId } = require("../utils/inputSecurity.util");

/**
 * Delivery fee = basePrice + (orderCount - 1) * extraOrderPrice
 * First order pays base; each additional order pays extra.
 */
function calculateFeeFromCompany(company, orderCount = 0) {
  const count = Math.max(0, Number(orderCount) || 0);
  const basePrice = Number(company?.basePrice) || 0;
  const extraOrderPrice = Number(company?.extraOrderPrice) || 0;
  const extraOrderCount = Math.max(0, count - 1);
  const totalFee = basePrice + extraOrderCount * extraOrderPrice;

  return {
    basePrice,
    extraOrderPrice,
    orderCount: count,
    extraOrderCount,
    totalFee,
    currency: company?.currency || "ILS",
  };
}

async function calculateFee(companyId, orderCount = 0) {
  const id = requireObjectId(companyId, "companyId");
  const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null, isActive: true }).lean();
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة أو غير مفعّلة");
    err.status = 404;
    throw err;
  }
  return calculateFeeFromCompany(company, orderCount);
}

module.exports = {
  calculateFeeFromCompany,
  calculateFee,
};
