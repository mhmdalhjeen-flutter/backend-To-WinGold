const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const {
  assertNoMongoOperators,
  cleanString,
  requireObjectId,
} = require("../utils/inputSecurity.util");
const { normalizeLocalPhone, isValidLocalPhone } = require("../utils/phone.util");

async function resolveCompanyId(user) {
  const companyId = user?.deliveryCompanyId;
  if (!companyId) {
    const err = new Error("حساب الشركة غير مربوط بشركة توصيل");
    err.status = 403;
    throw err;
  }
  return companyId;
}

function formatDriver(doc) {
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  return {
    _id: plain._id,
    name: plain.name,
    phone: plain.phone,
    whatsapp: plain.whatsapp || "",
    notes: plain.notes || "",
    isActive: Boolean(plain.isActive),
    hasAccount: Boolean(plain.userId),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listDrivers(user, { q = "", activeOnly = false } = {}) {
  const companyId = await resolveCompanyId(user);
  const query = { deliveryCompany: companyId };

  if (activeOnly) {
    query.isActive = true;
  }

  const term = cleanString(q, { field: "q", max: 80 });
  if (term) {
    const regex = new RegExp(escapeRegex(term), "i");
    query.$or = [{ name: regex }, { phone: regex }, { whatsapp: regex }];
  }

  const drivers = await DeliveryCompanyDriver.find(query)
    .sort({ isActive: -1, name: 1 })
    .limit(100)
    .lean();

  return drivers.map(formatDriver);
}

async function getDriver(user, driverId) {
  const companyId = await resolveCompanyId(user);
  const id = requireObjectId(driverId, "driverId");
  const driver = await DeliveryCompanyDriver.findOne({ _id: id, deliveryCompany: companyId });
  if (!driver) {
    const err = new Error("السائق غير موجود");
    err.status = 404;
    throw err;
  }
  return formatDriver(driver);
}

async function assertDriverForCompany(user, driverId, { requireActive = false } = {}) {
  const companyId = await resolveCompanyId(user);
  const id = requireObjectId(driverId, "driverId");
  const query = { _id: id, deliveryCompany: companyId };
  if (requireActive) query.isActive = true;

  const driver = await DeliveryCompanyDriver.findOne(query);
  if (!driver) {
    const err = new Error(requireActive ? "السائق غير موجود أو غير نشط" : "السائق غير موجود");
    err.status = requireActive ? 400 : 404;
    throw err;
  }
  return driver;
}

function validatePhoneFields(body) {
  const phone = normalizeLocalPhone(body.phone);
  if (!phone || !isValidLocalPhone(phone)) {
    const err = new Error("رقم الهاتف غير صالح");
    err.status = 400;
    throw err;
  }

  let whatsapp = "";
  if (body.whatsapp) {
    whatsapp = normalizeLocalPhone(body.whatsapp);
    if (whatsapp && !isValidLocalPhone(whatsapp)) {
      const err = new Error("رقم الواتساب غير صالح");
      err.status = 400;
      throw err;
    }
  }

  return { phone, whatsapp };
}

async function createDriver(user, body = {}) {
  assertNoMongoOperators(body, "driver");
  const companyId = await resolveCompanyId(user);
  const { phone, whatsapp } = validatePhoneFields(body);

  const driver = await DeliveryCompanyDriver.create({
    deliveryCompany: companyId,
    name: cleanString(body.name, { field: "name", max: 120, required: true }),
    phone,
    whatsapp,
    notes: cleanString(body.notes, { field: "notes", max: 500 }),
    isActive: body.isActive !== false,
  });

  return formatDriver(driver);
}

async function updateDriver(user, driverId, body = {}) {
  assertNoMongoOperators(body, "driver");
  const driver = await assertDriverForCompany(user, driverId);

  if (body.name !== undefined) {
    driver.name = cleanString(body.name, { field: "name", max: 120, required: true });
  }
  if (body.phone !== undefined || body.whatsapp !== undefined) {
    const { phone, whatsapp } = validatePhoneFields({
      phone: body.phone ?? driver.phone,
      whatsapp: body.whatsapp ?? driver.whatsapp,
    });
    driver.phone = phone;
    driver.whatsapp = whatsapp;
  }
  if (body.notes !== undefined) {
    driver.notes = cleanString(body.notes, { field: "notes", max: 500 });
  }
  if (body.isActive !== undefined) {
    driver.isActive = Boolean(body.isActive);
  }

  await driver.save();
  return formatDriver(driver);
}

async function deleteDriver(user, driverId) {
  const companyId = await resolveCompanyId(user);
  const id = requireObjectId(driverId, "driverId");
  const deleted = await DeliveryCompanyDriver.findOneAndDelete({ _id: id, deliveryCompany: companyId });
  if (!deleted) {
    const err = new Error("السائق غير موجود");
    err.status = 404;
    throw err;
  }
}

module.exports = {
  listDrivers,
  getDriver,
  assertDriverForCompany,
  createDriver,
  updateDriver,
  deleteDriver,
  formatDriver,
};
