const DeliveryCompany = require("../../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../../models/deliveryCompanyPaymentAccount");
const User = require("../../models/user");
const bcrypt = require("bcryptjs");
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
const { normalizePaymentType, isValidPaymentType, normalizeAccountKind } = require("../../utils/paymentMethodTypes.util");

const { normalizeLocalPhone } = require("../../utils/phone.util");
const { cleanAuthPassword } = require("../../utils/authValidation.util");

function toPortalAccountSummary(user) {
  if (!user) return null;
  const plain = user.toObject ? user.toObject() : user;
  return {
    _id: plain._id,
    name: plain.name,
    email: plain.email || "",
    phone: plain.phone || "",
    identifier: plain.email || plain.phone || "",
    isActive: plain.status === "active",
    status: plain.status,
    portalActivated: Boolean(plain.portalActivated),
  };
}

function parsePortalIdentifier(identifier) {
  const clean = cleanString(identifier, { field: "identifier", max: 120, required: true });
  if (clean.includes("@")) {
    return { email: clean.toLowerCase(), phone: undefined };
  }
  return { email: undefined, phone: normalizeLocalPhone(clean) };
}

async function assertPortalIdentifierAvailable({ email, phone }, exceptUserId = null) {
  const or = [
    email ? { email } : null,
    phone ? { phone } : null,
  ].filter(Boolean);
  if (!or.length) {
    const err = new Error("أدخل بريداً إلكترونياً أو رقم هاتف صالحاً");
    err.status = 400;
    throw err;
  }

  const query = { $or: or };
  if (exceptUserId) query._id = { $ne: exceptUserId };

  const existing = await User.findOne(query);
  if (existing) {
    const err = new Error("رقم الهاتف أو البريد مستخدم مسبقاً");
    err.status = 400;
    throw err;
  }
}

async function createPendingPortalUser(company, phone) {
  const normalizedPhone = normalizeLocalPhone(phone);
  if (!normalizedPhone) {
    const err = new Error("رقم الهاتف غير صالح");
    err.status = 400;
    throw err;
  }

  const existing = await User.findOne({ phone: normalizedPhone });
  if (existing) {
    const err = new Error("رقم الهاتف مستخدم مسبقاً");
    err.status = 400;
    throw err;
  }

  const existingPortal = await User.findOne({
    role: "delivery_company",
    deliveryCompanyId: company._id,
  });
  if (existingPortal) {
    const err = new Error("يوجد حساب بوابة لهذه الشركة مسبقاً");
    err.status = 400;
    throw err;
  }

  return User.create({
    name: company.name,
    phone: normalizedPhone,
    role: "delivery_company",
    deliveryCompanyId: company._id,
    password: null,
    portalActivated: false,
    status: "active",
  });
}

async function createPortalUserForCompany(company, portalAccount = {}) {
  assertNoMongoOperators(portalAccount, "portalAccount");
  const password = cleanAuthPassword(portalAccount.password);
  const { email, phone } = parsePortalIdentifier(portalAccount.identifier);
  await assertPortalIdentifierAvailable({ email, phone });

  const existingPortal = await User.findOne({
    role: "delivery_company",
    deliveryCompanyId: company._id,
  });
  if (existingPortal) {
    const err = new Error("يوجد حساب بوابة لهذه الشركة مسبقاً");
    err.status = 400;
    throw err;
  }

  const name = cleanString(portalAccount.name || company.name, { field: "name", max: 120, required: true });
  const isActive = portalAccount.isActive !== false;
  const hashedPassword = await bcrypt.hash(password, 10);

  return User.create({
    name,
    phone,
    email,
    password: hashedPassword,
    role: "delivery_company",
    deliveryCompanyId: company._id,
    status: isActive ? "active" : "suspended",
    portalActivated: true,
  });
}

async function updatePortalUserForCompany(company, portalAccount = {}) {
  assertNoMongoOperators(portalAccount, "portalAccount");

  let user = await User.findOne({
    role: "delivery_company",
    deliveryCompanyId: company._id,
  });

  if (!user) {
    if (!portalAccount.identifier || !portalAccount.password) {
      const err = new Error("يجب إدخال بيانات حساب الدخول");
      err.status = 400;
      throw err;
    }
    return createPortalUserForCompany(company, portalAccount);
  }

  if (portalAccount.identifier !== undefined) {
    const { email, phone } = parsePortalIdentifier(portalAccount.identifier);
    await assertPortalIdentifierAvailable({ email, phone }, user._id);
    user.email = email;
    user.phone = phone;
  }

  if (portalAccount.password) {
    user.password = await bcrypt.hash(cleanAuthPassword(portalAccount.password), 10);
  }

  if (portalAccount.isActive !== undefined) {
    user.status = portalAccount.isActive ? "active" : "suspended";
  }

  if (portalAccount.name) {
    user.name = cleanString(portalAccount.name, { field: "name", max: 120, required: true });
  }

  await user.save();
  return user;
}

async function listCompaniesWithAccounts() {
  const companies = await DeliveryCompany.find({ deletedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  if (!companies.length) return [];

  const ids = companies.map((c) => c._id);
  const handoverService = require("../services/deliveryCompanyHandover.service");
  const [accounts, portalUsers, lifetimeHandoverCounts] = await Promise.all([
    DeliveryCompanyPaymentAccount.find({ deliveryCompany: { $in: ids } })
      .sort({ type: 1, isActive: -1, createdAt: -1 })
      .lean(),
    User.find({
      role: "delivery_company",
      deliveryCompanyId: { $in: ids },
    })
      .select("name email phone status deliveryCompanyId")
      .lean(),
    handoverService.countHandoversByCompaniesLifetime(ids),
  ]);

  const byCompany = accounts.reduce((acc, row) => {
    const key = String(row.deliveryCompany);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const portalByCompany = portalUsers.reduce((acc, user) => {
    acc[String(user.deliveryCompanyId)] = user;
    return acc;
  }, {});

  return companies.map((company) => ({
    ...toAdminCompany(company, byCompany[String(company._id)] || [], {
      handedOverOrderCount: lifetimeHandoverCounts.get(String(company._id)) ?? company.handedOverOrderCount ?? 0,
    }),
    portalAccount: toPortalAccountSummary(portalByCompany[String(company._id)]),
    deliveryProofsPath: `/delivery-proofs?companyId=${String(company._id)}`,
  }));
}

function applyPaymentMethods(company, paymentMethods = {}) {
  const { applyPaymentMethodToggles, DEFAULT_DELIVERY_PAYMENT_TOGGLES } = require("../../utils/paymentMethodTypes.util");
  applyPaymentMethodToggles(company, paymentMethods, DEFAULT_DELIVERY_PAYMENT_TOGGLES);
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
    const address = cleanString(req.body.address, { field: "address", max: 500, required: true });
    const slug = await ensureUniqueSlug(name);
    const deliveryFee = req.body.deliveryFeePerOrder ?? req.body.basePrice ?? 0;
    const basePrice = numberInRange(deliveryFee, { field: "deliveryFeePerOrder", min: 0, max: 100_000 });
    const logo = req.body.logo
      ? await processOptionalImage(req.body.logo, {
        maxWidth: 512,
        enforceCloudinaryHttps: true,
      })
      : "";

    const company = await DeliveryCompany.create({
      name,
      slug,
      phone,
      address,
      logo,
      basePrice,
      extraOrderPrice: 0,
      currency: "ILS",
      isActive: req.body.isActive !== false,
      servesAllRegions: false,
      servedRegionIds: [],
    });

    try {
      await createPendingPortalUser(company, phone);
    } catch (portalErr) {
      await DeliveryCompany.findByIdAndDelete(company._id);
      throw portalErr;
    }

    const portalUser = await User.findOne({
      role: "delivery_company",
      deliveryCompanyId: company._id,
    }).select("name email phone status deliveryCompanyId portalActivated");

    res.status(201).json({
      company: {
        ...toAdminCompany(company, []),
        portalAccount: toPortalAccountSummary(portalUser),
      },
      message: "تم تسجيل الشركة — ستُفعّل من بوابة التوصيل عند أول دخول",
    });
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
    if (req.body.address !== undefined) {
      company.address = cleanString(req.body.address, { field: "address", max: 500 });
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
    if (req.body.pricePerDeliveredOrder !== undefined) {
      company.pricePerDeliveredOrder = numberInRange(req.body.pricePerDeliveredOrder, {
        field: "pricePerDeliveredOrder",
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

    if (req.body.servesAllRegions !== undefined) {
      company.servesAllRegions = Boolean(req.body.servesAllRegions);
      if (company.servesAllRegions) {
        company.servedRegionIds = [];
      } else if (Array.isArray(req.body.servedRegionIds)) {
        company.servedRegionIds = req.body.servedRegionIds.map((regionId) => requireObjectId(regionId, "servedRegionIds"));
      }
    } else if (Array.isArray(req.body.servedRegionIds)) {
      company.servedRegionIds = req.body.servedRegionIds.map((regionId) => requireObjectId(regionId, "servedRegionIds"));
    }

    if (req.body.paymentMethods !== undefined) {
      applyPaymentMethods(company, req.body.paymentMethods);
    }

    await company.save();

    const portalUser = await User.findOne({
      role: "delivery_company",
      deliveryCompanyId: company._id,
    });
    if (portalUser) {
      if (req.body.name !== undefined) portalUser.name = company.name;
      if (req.body.phone !== undefined && !portalUser.portalActivated) {
        const normalizedPhone = normalizeLocalPhone(company.phone);
        const phoneTaken = await User.findOne({ phone: normalizedPhone, _id: { $ne: portalUser._id } });
        if (phoneTaken) {
          return res.status(400).json({ message: "رقم الهاتف مستخدم مسبقاً" });
        }
        portalUser.phone = normalizedPhone;
      }
      await portalUser.save();
    }

    if (req.body.portalAccount) {
      await updatePortalUserForCompany(company, req.body.portalAccount);
    }

    const accounts = await listPaymentAccounts(company._id);
    const portalUserDoc = await User.findOne({
      role: "delivery_company",
      deliveryCompanyId: company._id,
    }).select("name email phone status deliveryCompanyId portalActivated");

    res.json({
      company: {
        ...toAdminCompany(company, accounts),
        portalAccount: toPortalAccountSummary(portalUserDoc),
      },
    });
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
      accountType: normalizeAccountKind(req.body.accountType),
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
    if (req.body.accountType !== undefined) {
      account.accountType = normalizeAccountKind(req.body.accountType);
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

exports.createPortalAccount = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "portalAccount");
    const companyId = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    const user = await createPortalUserForCompany(company, {
      identifier: req.body.identifier || req.body.email || req.body.phone,
      password: req.body.password,
      name: req.body.name,
      isActive: req.body.isActive,
    });

    res.status(201).json({
      message: "تم إنشاء حساب بوابة الشركة",
      portalAccount: toPortalAccountSummary(user),
    });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.updatePortalAccount = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "portalAccount");
    const companyId = requireObjectId(req.params.id, "id");
    const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null });
    if (!company) return res.status(404).json({ message: "شركة التوصيل غير موجودة" });

    const user = await updatePortalUserForCompany(company, {
      identifier: req.body.identifier || req.body.email || req.body.phone,
      password: req.body.password,
      name: req.body.name,
      isActive: req.body.isActive,
    });

    res.json({
      message: "تم تحديث حساب البوابة",
      portalAccount: toPortalAccountSummary(user),
    });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
