const deliverySessionService = require("../services/deliverySession.service");
const deliveryCompanyPortalService = require("../services/deliveryCompanyPortal.service");
const deliveryCompanyDriverService = require("../services/deliveryCompanyDriver.service");
const deliveryProofService = require("../services/deliveryProof.service");
const { requireObjectId } = require("../utils/inputSecurity.util");

exports.getDashboardStats = async (req, res) => {
  try {
    const stats = await deliverySessionService.getDashboardStats(req.userDoc || req.user);
    res.json(stats);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPendingHandovers = async (req, res) => {
  try {
    const companyId = (req.userDoc || req.user)?.deliveryCompanyId;
    if (!companyId) {
      return res.status(403).json({ message: "حساب الشركة غير مربوط بشركة توصيل" });
    }
    const handoverService = require("../services/deliveryCompanyHandover.service");
    const handovers = await handoverService.listPendingCustomerDeliveriesForCompany(companyId);
    res.json({ handovers, count: handovers.length });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listRequests = async (req, res) => {
  try {
    const history = req.query.history === "true" || req.query.history === "1";
    const requests = await deliverySessionService.listSessionsForCompany(
      req.userDoc || req.user,
      { status: req.query.status, history },
    );
    res.json({ requests, sessions: requests, trips: requests });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getRequest = async (req, res) => {
  try {
    const request = await deliverySessionService.getSessionForCompany(
      req.userDoc || req.user,
      req.params.requestId,
    );
    res.json({ request, session: request, trip: request });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.assignDriver = async (req, res) => {
  try {
    requireObjectId(req.body?.driverId, "driverId");
    const request = await deliverySessionService.assignDriverToSession(
      req.userDoc || req.user,
      req.params.requestId,
      { driverId: req.body.driverId, note: req.body.note },
    );
    res.json({ request, session: request, trip: request, message: "تم تعيين السائق بنجاح" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.rejectRequest = async (req, res) => {
  try {
    const request = await deliverySessionService.rejectSession(
      req.userDoc || req.user,
      req.params.requestId,
      req.body?.reason,
    );
    res.json({ request, session: request, trip: request, message: "تم رفض الطلب" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.markOutForDelivery = async (req, res) => {
  try {
    const request = await deliverySessionService.markOutForDelivery(
      req.userDoc || req.user,
      req.params.requestId,
    );
    res.json({ request, session: request, trip: request, message: "تم تحديث الحالة — قيد التوصيل" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.completeRequest = async (req, res) => {
  try {
    const request = await deliverySessionService.completeSession(
      req.userDoc || req.user,
      req.params.requestId,
    );
    res.json({ request, session: request, trip: request, message: "تم تأكيد التسليم" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const company = await deliveryCompanyPortalService.getCompanyProfile(req.userDoc || req.user);
    res.json({ company });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const company = await deliveryCompanyPortalService.updateCompanyProfile(req.userDoc || req.user, req.body);
    res.json({ company, message: "تم حفظ الإعدادات" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getPaymentSettings = async (req, res) => {
  try {
    const data = await deliveryCompanyPortalService.getPaymentSettings(req.userDoc || req.user);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updatePaymentMethods = async (req, res) => {
  try {
    const data = await deliveryCompanyPortalService.updatePaymentMethods(req.userDoc || req.user, req.body);
    res.json({ ...data, message: "تم حفظ طرق الدفع" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.listPaymentAccounts = async (req, res) => {
  try {
    const accounts = await deliveryCompanyPortalService.listPaymentAccounts(req.userDoc || req.user);
    res.json({ accounts });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createPaymentAccount = async (req, res) => {
  try {
    const account = await deliveryCompanyPortalService.createPaymentAccount(req.userDoc || req.user, req.body);
    res.status(201).json({ account, message: "تم إضافة الحساب" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.updatePaymentAccount = async (req, res) => {
  try {
    requireObjectId(req.params.accountId, "accountId");
    const account = await deliveryCompanyPortalService.updatePaymentAccount(
      req.userDoc || req.user,
      req.params.accountId,
      req.body,
    );
    res.json({ account, message: "تم تحديث الحساب" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.deletePaymentAccount = async (req, res) => {
  try {
    requireObjectId(req.params.accountId, "accountId");
    await deliveryCompanyPortalService.deletePaymentAccount(req.userDoc || req.user, req.params.accountId);
    res.json({ message: "تم حذف الحساب" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getRegions = async (req, res) => {
  try {
    const data = await deliveryCompanyPortalService.getRegions(req.userDoc || req.user);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updateRegions = async (req, res) => {
  try {
    const data = await deliveryCompanyPortalService.updateRegions(req.userDoc || req.user, req.body);
    res.json({ ...data, message: "تم حفظ مناطق الخدمة" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getPricing = async (req, res) => {
  try {
    const pricing = await deliveryCompanyPortalService.getPricing(req.userDoc || req.user);
    res.json({ pricing });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updatePricing = async (req, res) => {
  try {
    const data = await deliveryCompanyPortalService.updatePricing(req.userDoc || req.user, req.body);
    res.json({ ...data, message: "تم حفظ أسعار التوصيل" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.listDrivers = async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly === "true" || req.query.activeOnly === "1";
    const drivers = await deliveryCompanyDriverService.listDrivers(req.userDoc || req.user, {
      q: req.query.q,
      activeOnly,
    });
    res.json({ drivers });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getDriver = async (req, res) => {
  try {
    const driver = await deliveryCompanyDriverService.getDriver(req.userDoc || req.user, req.params.driverId);
    res.json({ driver });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createDriver = async (req, res) => {
  try {
    const driver = await deliveryCompanyDriverService.createDriver(req.userDoc || req.user, req.body);
    res.status(201).json({ driver, message: "تم إضافة السائق" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.updateDriver = async (req, res) => {
  try {
    const driver = await deliveryCompanyDriverService.updateDriver(
      req.userDoc || req.user,
      req.params.driverId,
      req.body,
    );
    res.json({ driver, message: "تم تحديث السائق" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.deleteDriver = async (req, res) => {
  try {
    await deliveryCompanyDriverService.deleteDriver(req.userDoc || req.user, req.params.driverId);
    res.json({ message: "تم حذف السائق" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getDriverRegistrationPasswordStatus = async (req, res) => {
  try {
    const deliveryDriverService = require("../services/deliveryDriver.service");
    const data = await deliveryDriverService.getDriverRegistrationPasswordStatus(req.userDoc || req.user);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listProofs = async (req, res) => {
  try {
    const companyId = (req.userDoc || req.user)?.deliveryCompanyId;
    if (!companyId) {
      return res.status(403).json({ message: "حساب الشركة غير مربوط بشركة توصيل" });
    }
    const proofs = await deliveryProofService.listProofs(
      {
        driverId: req.query.driverId,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        verificationCode: req.query.verificationCode,
        customer: req.query.customer,
      },
      {
        companyId,
        includeCompany: false,
        limit: req.query.limit,
      },
    );
    res.json({ proofs });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getProof = async (req, res) => {
  try {
    const companyId = (req.userDoc || req.user)?.deliveryCompanyId;
    if (!companyId) {
      return res.status(403).json({ message: "حساب الشركة غير مربوط بشركة توصيل" });
    }
    const proof = await deliveryProofService.getProofById(req.params.proofId, {
      companyId,
      includeCompany: false,
    });
    res.json({ proof });
  } catch (err) {
    res.status(err.status || 404).json({ message: err.message });
  }
};

exports.listProofFilterOptions = async (req, res) => {
  try {
    const companyId = (req.userDoc || req.user)?.deliveryCompanyId;
    if (!companyId) {
      return res.status(403).json({ message: "حساب الشركة غير مربوط بشركة توصيل" });
    }
    const options = await deliveryProofService.listProofFilterOptions({ companyId });
    res.json(options);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.setDriverRegistrationPassword = async (req, res) => {
  try {
    const deliveryDriverService = require("../services/deliveryDriver.service");
    const data = await deliveryDriverService.setDriverRegistrationPassword(
      req.userDoc || req.user,
      req.body,
    );
    res.json({ ...data, message: "تم حفظ كلمة مرور تسجيل السائقين" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
