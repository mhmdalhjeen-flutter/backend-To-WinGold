const deliveryDriverService = require("../services/deliveryDriver.service");
const { assertNoMongoOperators } = require("../utils/inputSecurity.util");

/** Prefer attachUserDoc payload — auth middleware's req.user omits deliveryDriverId. */
function driverAuthUser(req) {
  return req.userDoc || req._authUserDoc || req.user;
}

exports.listAssignments = async (req, res) => {
  try {
    const assignments = await deliveryDriverService.listActiveAssignments(driverAuthUser(req));
    res.json({ assignments });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listHistory = async (req, res) => {
  try {
    const assignments = await deliveryDriverService.listDeliveryHistory(driverAuthUser(req), {
      limit: req.query.limit,
    });
    res.json({ assignments, history: assignments });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getAssignment = async (req, res) => {
  try {
    const assignment = await deliveryDriverService.getAssignmentDetail(
      driverAuthUser(req),
      req.params.assignmentId,
    );
    res.json({ assignment });
  } catch (err) {
    res.status(err.status || 404).json({ message: err.message });
  }
};

exports.completeDelivery = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "delivery");
    const assignment = await deliveryDriverService.completeDelivery(
      driverAuthUser(req),
      req.params.assignmentId,
      {
        deliveryProof: req.body.deliveryProof,
        deliveryNote: req.body.deliveryNote,
        clientSyncId: req.body.clientSyncId,
      },
    );
    res.json({ assignment, message: "تم استلام الطلب بنجاح" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.syncOffline = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = await deliveryDriverService.syncOfflineCompletions(driverAuthUser(req), items);
    res.json({ results, synced: results.filter((r) => r.success).length });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};

exports.getRegistrationPasswordStatus = async (req, res) => {
  try {
    const data = await deliveryDriverService.getDriverRegistrationPasswordStatus(req.userDoc || req.user);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.setRegistrationPassword = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "driverPassword");
    const data = await deliveryDriverService.setDriverRegistrationPassword(
      req.userDoc || req.user,
      req.body,
    );
    res.json({ ...data, message: "تم حفظ كلمة مرور تسجيل السائقين" });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
};
