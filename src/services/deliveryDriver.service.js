const User = require("../models/user");
const { requireObjectId } = require("../utils/inputSecurity.util");

/**
 * Delivery drivers are Users with role=driver and deliveryCompanyId.
 * This service provides company-scoped driver helpers without duplicating user storage.
 */
async function listDriversForCompany(companyId) {
  const id = requireObjectId(companyId, "companyId");
  return User.find({ role: "driver", deliveryCompanyId: id })
    .select("name phone whatsapp deliveryCompanyId createdAt")
    .sort({ name: 1 })
    .lean();
}

async function assertDriverBelongsToCompany(driverId, companyId) {
  const driver = await User.findOne({
    _id: requireObjectId(driverId, "driverId"),
    role: "driver",
    deliveryCompanyId: requireObjectId(companyId, "companyId"),
  }).lean();
  if (!driver) {
    const err = new Error("السائق غير موجود أو لا ينتمي لهذه الشركة");
    err.status = 404;
    throw err;
  }
  return driver;
}

module.exports = {
  listDriversForCompany,
  assertDriverBelongsToCompany,
};
