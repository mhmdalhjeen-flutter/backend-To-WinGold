const DeliveryCompany = require("../../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../../models/deliveryCompanyPaymentAccount");
const {
  ensureUniqueSlug,
  deactivateAccountSiblings,
  listPaymentAccounts,
  toAdminCompany,
  loadCompanyWithAccounts,
} = require("../../services/deliveryCompany.service");
const {
  assertNoMongoOperators,
  cleanString,
  numberInRange,
  requireObjectId,
} = require("../../utils/inputSecurity.util");
const { processOptionalImage } = require("../../utils/imageProcess.util");
const { normalizePaymentType, isValidPaymentType } = require("../../utils/paymentMethodTypes.util");

async function listCompaniesWithAccounts() {
  const companies = await DeliveryCompany.find({ deletedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  if (!companies.length) return [];

  const ids = companies.map((c) => c._id);
  const accounts = await DeliveryCompanyPaymentAccount.find({ deliveryCompany: { $in: ids } })
    .sort({ type: 1, isActive: -1, createdAt: -1 })
    .lean();

  const byCompany = accounts.reduce((acc, row) => {
    const key = String(row.deliveryCompany);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  return companies.map((company) => toAdminCompany(company, byCompany[String(company._id)] || []));
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

exports.list = async (_req, res) => {
  try {
    const companies = await listCompaniesWithAccounts();
    res.json({ companies });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "deliveryCompany");
    const name = cleanString(req.body.name, { field: "name", max: 120, required: true });
    const phone = cleanString(req.body.phone, { field: "phone", max: 32, required: true });
    const slugInput = cleanString(req.body.slug, { field: "slug", max: 80 });
    const slug = await ensureUniqueSlug(slugInput || name);

    const logo = req.body.logo
      ? await processOptionalImage(req.body.logo, { maxWidth: 512, enforceCloudinaryHttps: true })
      : "";

    const company = await DeliveryCompany.create({
      name,
      nameEn: cleanString(req.body.nameEn, { field: "nameEn", max: 120 }),
      slug,
      phone,
      whatsapp: cleanString(req.body.whatsapp, { field: "whatsapp", max: 32 }),
      description: cleanString(req.body.description, { field: "description", max: 2000 }),
      logo,
      basePrice: numberInRange(req.body.basePrice, { field: "basePrice", min: 0, max: 100_000, required: true }),
      extraOrderPrice: numberInRange(req.body.extraOrderPrice, {
        field: "extraOrderPrice",
        min: 0,
        max: 100_000,
        required: true,
      }),
      currency: cleanString(req.body.currency || "ILS", { field: "currency", max: 8 }),
      isActive: req.body.isActive !== false,
      servesAllRegions: Boolean(req.body.servesAllRegions),
      servedRegionIds: [],
    });

    res.status(201).json({ company: toAdminCompany(company, []) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "deliveryCompany");
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    if (req.body.name !== undefined) {
      company.name = cleanString(req.body.name, { field: "name", max: 120, required: true });
    }
    if (req.body.nameEn !== undefined) {
      company.nameEn = cleanString(req.body.nameEn, { field: "nameEn", max: 120 });
    }
    if (req.body.slug !== undefined) {
      const slugInput = cleanString(req.body.slug, { field: "slug", max: 80, required: true });
      company.slug = await ensureUniqueSlug(slugInput, company._id);
    }
    if (req.body.phone !== undefined) {
      company.phone = cleanString(req.body.phone, { field: "phone", max: 32, required: true });
    }
    if (req.body.whatsapp !== undefined) {
      company.whatsapp = cleanString(req.body.whatsapp, { field: "whatsapp", max: 32 });
    }
    if (req.body.description !== undefined) {
      company.description = cleanString(req.body.description, { field: "description", max: 2000 });
    }
    if (req.body.logo !== undefined) {
      company.logo = req.body.logo
        ? await processOptionalImage(req.body.logo, {
          maxWidth: 512,
          enforceCloudinaryHttps: true,
          previousValue: company.logo,
        })
        : "";
    }
    if (req.body.basePrice !== undefined) {
      company.basePrice = numberInRange(req.body.basePrice, { field: "basePrice", min: 0, max: 100_000 });
    }
    if (req.body.extraOrderPrice !== undefined) {
      company.extraOrderPrice = numberInRange(req.body.extraOrderPrice, {
        field: "extraOrderPrice",
        min: 0,
        max: 100_000,
      });
    }
    if (req.body.currency !== undefined) {
      company.currency = cleanString(req.body.currency, { field: "currency", max: 8 });
    }
    if (req.body.isActive !== undefined) {
      company.isActive = Boolean(req.body.isActive);
    }

    await company.save();
    const accounts = await listPaymentAccounts(company._id);
    res.json({ company: toAdminCompany(company, accounts) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.toggle = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    company.isActive = !company.isActive;
    await company.save();

    res.json({
      isActive: company.isActive,
      message: company.isActive ? "تم تفعيل الشركة" : "تم تعطيل الشركة",
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    company.deletedAt = new Date();
    company.isActive = false;
    await company.save();

    res.json({ message: "تم حذف الشركة" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updateAreas = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "areas");
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    company.servesAllRegions = Boolean(req.body.servesAllRegions);
    if (company.servesAllRegions) {
      company.servedRegionIds = [];
    } else {
      const ids = Array.isArray(req.body.servedRegionIds) ? req.body.servedRegionIds : [];
      company.servedRegionIds = ids.map((regionId) => requireObjectId(regionId, "servedRegionIds"));
    }

    await company.save();
    const accounts = await listPaymentAccounts(company._id);
    res.json({ company: toAdminCompany(company, accounts) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.updatePaymentMethods = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentMethods");
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    applyPaymentMethods(company, req.body.paymentMethods);
    await company.save();

    const accounts = await listPaymentAccounts(company._id);
    res.json({ company: toAdminCompany(company, accounts) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.listPaymentAccounts = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    const accounts = await listPaymentAccounts(id);
    res.json(accounts);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createPaymentAccount = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentAccount");
    const id = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: id, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    const rawType = cleanString(req.body.type, { field: "type", max: 40, required: true });
    const type = normalizePaymentType(rawType);
    if (!isValidPaymentType(rawType) || type === "cash_on_delivery") {
      return res.status(400).json({ message: "نوع الدفع غير مدعوم" });
    }

    const qrCodeUrl = req.body.qrCodeUrl
      ? await processOptionalImage(req.body.qrCodeUrl, { maxWidth: 800, enforceCloudinaryHttps: true })
      : "";

    const wantsActive = req.body.isActive !== false;
    if (wantsActive) {
      await deactivateAccountSiblings(id, type);
    }

    const account = await DeliveryCompanyPaymentAccount.create({
      deliveryCompany: id,
      type,
      accountName: cleanString(req.body.accountName, { field: "accountName", max: 120, required: true }),
      accountNumber: cleanString(req.body.accountNumber, { field: "accountNumber", max: 64, required: true }),
      iban: cleanString(req.body.iban, { field: "iban", max: 64 }),
      qrCodeUrl,
      isActive: wantsActive,
    });

    res.status(201).json(account);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.updatePaymentAccount = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "paymentAccount");
    const companyId = requireObjectId(req.params.id, "id");
    const accountId = requireObjectId(req.params.accountId, "accountId");

    const account = await DeliveryCompanyPaymentAccount.findOne({
      _id: accountId,
      deliveryCompany: companyId,
    });
    if (!account) return res.status(404).json({ message: "الحساب غير موجود" });

    if (req.body.type !== undefined) {
      const rawType = cleanString(req.body.type, { field: "type", max: 40, required: true });
      const type = normalizePaymentType(rawType);
      if (!isValidPaymentType(rawType) || type === "cash_on_delivery") {
        return res.status(400).json({ message: "نوع الدفع غير مدعوم" });
      }
      account.type = type;
    }
    if (req.body.accountName !== undefined) {
      account.accountName = cleanString(req.body.accountName, { field: "accountName", max: 120, required: true });
    }
    if (req.body.accountNumber !== undefined) {
      account.accountNumber = cleanString(req.body.accountNumber, { field: "accountNumber", max: 64, required: true });
    }
    if (req.body.iban !== undefined) {
      account.iban = cleanString(req.body.iban, { field: "iban", max: 64 });
    }
    if (req.body.qrCodeUrl !== undefined) {
      account.qrCodeUrl = req.body.qrCodeUrl
        ? await processOptionalImage(req.body.qrCodeUrl, {
          maxWidth: 800,
          enforceCloudinaryHttps: true,
          previousValue: account.qrCodeUrl,
        })
        : "";
    }
    if (req.body.isActive === true) {
      await deactivateAccountSiblings(companyId, account.type, account._id);
      account.isActive = true;
    } else if (req.body.isActive === false) {
      account.isActive = false;
    }

    await account.save();
    res.json(account);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.deletePaymentAccount = async (req, res) => {
  try {
    const companyId = requireObjectId(req.params.id, "id");
    const accountId = requireObjectId(req.params.accountId, "accountId");

    const account = await DeliveryCompanyPaymentAccount.findOneAndDelete({
      _id: accountId,
      deliveryCompany: companyId,
    });
    if (!account) return res.status(404).json({ message: "الحساب غير موجود" });

    res.json({ message: "تم حذف الحساب" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
