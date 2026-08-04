const deliverySessionService = require("../services/deliverySession.service");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

exports.getActiveSession = async (req, res) => {
  try {
    const session = await deliverySessionService.getActiveSessionForCustomer(req.user.id);
    res.json({ session });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getSession = async (req, res) => {
  try {
    const session = await deliverySessionService.getSessionForCustomer(req.user.id, req.params.sessionId);
    res.json({ session });
  } catch (err) {
    res.status(err.status || 404).json({ message: err.message });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const sessions = await deliverySessionService.listSessionsForCustomer(req.user.id);
    res.json({ sessions });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.calculateFee = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "deliveryFee");
    const orderCount = Math.max(0, Number(req.body.orderCount) || 0);
    const fee = await deliverySessionService.calculateSessionFee(req.body.companyId, orderCount);
    res.json(fee);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.confirmSession = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "deliverySession");
    const session = await deliverySessionService.confirmSession(req.user.id, req.body);
    res.status(201).json({ session, trip: session, message: "تم تأكيد طلب التوصيل بنجاح" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.cancelSession = async (req, res) => {
  try {
    const session = await deliverySessionService.cancelSession(
      req.user.id,
      req.params.sessionId,
      req.body?.reason,
    );
    res.json({ session, message: "تم إلغاء جلسة التوصيل" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
