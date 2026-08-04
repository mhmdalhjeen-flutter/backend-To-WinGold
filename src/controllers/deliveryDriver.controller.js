const deliverySessionService = require("../services/deliverySession.service");
const { requireObjectId } = require("../utils/inputSecurity.util");

exports.getDashboardStats = async (req, res) => {
  try {
    const stats = await deliverySessionService.getDashboardStats(req.userDoc || req.user);
    res.json(stats);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listTrips = async (req, res) => {
  try {
    const history = req.query.history === "true" || req.query.history === "1";
    const trips = await deliverySessionService.listSessionsForDriver(
      req.userDoc || req.user,
      { status: req.query.status, history },
    );
    res.json({ trips, sessions: trips });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getTrip = async (req, res) => {
  try {
    const trip = await deliverySessionService.getSessionForDriver(
      req.userDoc || req.user,
      req.params.tripId,
    );
    res.json({ trip, session: trip });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.acceptTrip = async (req, res) => {
  try {
    const trip = await deliverySessionService.acceptSession(req.userDoc || req.user, req.params.tripId);
    res.json({ trip, session: trip, message: "تم قبول الرحلة" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.collectStop = async (req, res) => {
  try {
    requireObjectId(req.params.orderId, "orderId");
    const trip = await deliverySessionService.collectStoreStop(
      req.userDoc || req.user,
      req.params.tripId,
      req.params.orderId,
    );
    res.json({ trip, session: trip, message: "تم استلام الطلب من المتجر" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const trip = await deliverySessionService.verifySessionPayment(
      req.userDoc || req.user,
      req.params.tripId,
    );
    res.json({ trip, session: trip, message: "تم التحقق من الدفع" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.startDelivery = async (req, res) => {
  try {
    const trip = await deliverySessionService.startDelivery(req.userDoc || req.user, req.params.tripId);
    res.json({ trip, session: trip, message: "تم بدء التوصيل" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.completeTrip = async (req, res) => {
  try {
    const trip = await deliverySessionService.completeSession(req.userDoc || req.user, req.params.tripId);
    res.json({ trip, session: trip, message: "تم إكمال الرحلة" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
