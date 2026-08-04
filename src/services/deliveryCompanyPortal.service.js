const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../models/deliveryCompanyPaymentAccount");
const Region = require("../models/region");
const {
  listPaymentAccounts,
  loadCompanyWithAccounts,
  toAdminCompany,
  deactivateAccountSiblings,
  buildPaymentSettingsFromAccounts,
} = require("./deliveryCompany.service");
const {
  assertNoMongoOperators,
  cleanString,
  numberInRange,
  requireObjectId,
} = require("../utils/inputSecurity.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { normalizePaymentType, isValidPaymentType } = require("../utils/paymentMethodTypes.util");

async function resolveCompanyId(user) {
  const companyId = user?.deliveryCompanyId;
  if (!companyId) {
    const err = new Error("حساب الشركة غير مربوط بشركة توصيل");
    err.status = 403;
    throw err;
  }
  return companyId;
}

async function loadOwnCompany(user) {
  const companyId = await resolveCompanyId(user);
  const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null, isActive: true });
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة أو غير مفعّلة");
    err.status = 404;
    throw err;
  }
  return company;
}

function applyPaymentMethods(company, paymentMethods = {}) {
  if (!paymentMethods || typeof paymentMethods !== "object") return;
  const keys = ["cashOnDelivery", "bankPalestine", "palPay", "jawwalPay"];
  keys.forEach((key) => {
    if (paymentMethods[key]?.enabled !== undefined) {
      company.paymentMethods[key] = { enabled: Boolean(paymentMethods[key].enabled) };
    }
  });
}

async function getCompanyProfile(user) {
  const company = await loadOwnCompany(user);
  const accounts = await listPaymentAccounts(company._id);
  return toAdminCompany(company, accounts);
}

async function updateCompanyProfile(user, body = {}) {
  assertNoMongoOperators(body, "deliveryCompany");
  const company = await loadOwnCompany(user);

  if (body.phone !== undefined) {
    company.phone = cleanString(body.phone, { field: "phone", max: 32, required: true });
  }
  if (body.whatsapp !== undefined) {
    company.whatsapp = cleanString(body.whatsapp, { field: "whatsapp", max: 32 });
  }
  if (body.description !== undefined) {
    company.description = cleanString(body.description, { field: "description", max: 2000 });
  }
  if (body.logo !== undefined) {
    company.logo = body.logo
      ? await processOptionalImage(body.logo, {
        maxWidth: 512,
        enforceCloudinaryHttps: true,
        previousValue: company.logo,
      })
      : "";
  }

  await company.save();
  const accounts = await listPaymentAccounts(company._id);
  return toAdminCompany(company, accounts);
}

async function getPaymentSettings(user) {
  const loaded = await loadCompanyWithAccounts(await resolveCompanyId(user));
  if (!loaded) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }
  const { company, accounts } = loaded;
  return {
    paymentMethods: company.paymentMethods,
    paymentSettings: buildPaymentSettingsFromAccounts(company.paymentMethods, accounts),
    accounts: accounts.map((a) => ({
      _id: a._id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      iban: a.iban || "",
      qrCodeUrl: a.qrCodeUrl || "",
      isActive: Boolean(a.isActive),
    })),
  };
}

async function updatePaymentMethods(user, body = {}) {
  assertNoMongoOperators(body, "paymentMethods");
  const company = await loadOwnCompany(user);
  applyPaymentMethods(company, body.paymentMethods);
  await company.save();
  return getPaymentSettings(user);
}

async function listPaymentAccountsForUser(user) {
  const companyId = await resolveCompanyId(user);
  return listPaymentAccounts(companyId);
}

async function createPaymentAccount(user, body = {}) {
  assertNoMongoOperators(body, "paymentAccount");
  const company = await loadOwnCompany(user);
  const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
  const type = normalizePaymentType(rawType);
  if (!isValidPaymentType(rawType) || type === "cash_on_delivery") {
    const err = new Error("نوع الدفع غير مدعوم");
    err.status = 400;
    throw err;
  }

  const qrCodeUrl = body.qrCodeUrl
    ? await processOptionalImage(body.qrCodeUrl, { maxWidth: 800, enforceCloudinaryHttps: true })
    : "";

  const wantsActive = body.isActive !== false;
  if (wantsActive) {
    await deactivateAccountSiblings(company._id, type);
  }

  return DeliveryCompanyPaymentAccount.create({
    deliveryCompany: company._id,
    type,
    accountName: cleanString(body.accountName, { field: "accountName", max: 120, required: true }),
    accountNumber: cleanString(body.accountNumber, { field: "accountNumber", max: 64, required: true }),
    iban: cleanString(body.iban, { field: "iban", max: 64 }),
    qrCodeUrl,
    isActive: wantsActive,
  });
}

async function updatePaymentAccount(user, accountId, body = {}) {
  assertNoMongoOperators(body, "paymentAccount");
  const companyId = await resolveCompanyId(user);
  await loadOwnCompany(user);

  const account = await DeliveryCompanyPaymentAccount.findOne({
    _id: requireObjectId(accountId, "accountId"),
    deliveryCompany: companyId,
  });
  if (!account) {
    const err = new Error("الحساب غير موجود");
    err.status = 404;
    throw err;
  }

  if (body.type !== undefined) {
    const rawType = cleanString(body.type, { field: "type", max: 40, required: true });
    const type = normalizePaymentType(rawType);
    if (!isValidPaymentType(rawType) || type === "cash_on_delivery") {
      const err = new Error("نوع الدفع غير مدعوم");
      err.status = 400;
      throw err;
    }
    account.type = type;
  }
  if (body.accountName !== undefined) {
    account.accountName = cleanString(body.accountName, { field: "accountName", max: 120, required: true });
  }
  if (body.accountNumber !== undefined) {
    account.accountNumber = cleanString(body.accountNumber, { field: "accountNumber", max: 64, required: true });
  }
  if (body.iban !== undefined) {
    account.iban = cleanString(body.iban, { field: "iban", max: 64 });
  }
  if (body.qrCodeUrl !== undefined) {
    account.qrCodeUrl = body.qrCodeUrl
      ? await processOptionalImage(body.qrCodeUrl, {
        maxWidth: 800,
        enforceCloudinaryHttps: true,
        previousValue: account.qrCodeUrl,
      })
      : "";
  }
  if (body.isActive === true) {
    await deactivateAccountSiblings(companyId, account.type, account._id);
    account.isActive = true;
  } else if (body.isActive === false) {
    account.isActive = false;
  }

  await account.save();
  return account;
}

async function deletePaymentAccount(user, accountId) {
  const companyId = await resolveCompanyId(user);
  await loadOwnCompany(user);

  const account = await DeliveryCompanyPaymentAccount.findOneAndDelete({
    _id: requireObjectId(accountId, "accountId"),
    deliveryCompany: companyId,
  });
  if (!account) {
    const err = new Error("الحساب غير موجود");
    err.status = 404;
    throw err;
  }
}

async function getRegions(user) {
  const company = await loadOwnCompany(user);
  const regions = await Region.find({ isActive: { $ne: false } })
    .select("name parent sortOrder")
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  return {
    servesAllRegions: Boolean(company.servesAllRegions),
    servedRegionIds: (company.servedRegionIds || []).map(String),
    regions,
  };
}

async function getPricing(user) {
  const company = await loadOwnCompany(user);
  return {
    basePrice: company.basePrice,
    extraOrderPrice: company.extraOrderPrice,
    currency: company.currency || "ILS",
  };
}

async function updatePricing(user, body = {}) {
  assertNoMongoOperators(body, "pricing");
  const company = await loadOwnCompany(user);

  if (body.basePrice !== undefined) {
    company.basePrice = numberInRange(body.basePrice, { field: "basePrice", min: 0, max: 100_000 });
  }
  if (body.extraOrderPrice !== undefined) {
    company.extraOrderPrice = numberInRange(body.extraOrderPrice, {
      field: "extraOrderPrice",
      min: 0,
      max: 100_000,
    });
  }
  if (body.currency !== undefined) {
    company.currency = cleanString(body.currency, { field: "currency", max: 8 });
  }

  await company.save();
  const accounts = await listPaymentAccounts(company._id);
  return {
    pricing: {
      basePrice: company.basePrice,
      extraOrderPrice: company.extraOrderPrice,
      currency: company.currency || "ILS",
    },
    company: toAdminCompany(company, accounts),
  };
}

async function updateRegions(user, body = {}) {
  assertNoMongoOperators(body, "regions");
  const company = await loadOwnCompany(user);

  company.servesAllRegions = Boolean(body.servesAllRegions);
  if (company.servesAllRegions) {
    company.servedRegionIds = [];
  } else {
    const ids = Array.isArray(body.servedRegionIds) ? body.servedRegionIds : [];
    company.servedRegionIds = ids.map((regionId) => requireObjectId(regionId, "servedRegionIds"));
  }

  await company.save();
  const accounts = await listPaymentAccounts(company._id);
  return {
    company: toAdminCompany(company, accounts),
    servesAllRegions: company.servesAllRegions,
    servedRegionIds: company.servedRegionIds.map(String),
  };
}

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  getPaymentSettings,
  updatePaymentMethods,
  listPaymentAccounts: listPaymentAccountsForUser,
  createPaymentAccount,
  updatePaymentAccount,
  deletePaymentAccount,
  getRegions,
  updateRegions,
  getPricing,
  updatePricing,
};
