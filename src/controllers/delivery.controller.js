const deliverySessionService = require("../services/deliverySession.service");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

/** @deprecated alias — use deliverySession.controller.confirmSession */
exports.createTrip = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "deliveryTrip");
    const session = await deliverySessionService.confirmSession(req.user.id, req.body);
    res.status(201).json({ trip: session, session, message: "تم إنشاء طلب التوصيل بنجاح" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
