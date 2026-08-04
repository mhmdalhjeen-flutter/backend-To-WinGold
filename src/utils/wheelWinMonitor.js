const WheelWin = require("../models/wheelWin");
const { safeLog } = require("./logSanitize.util");

const PURGE_DAYS = WheelWin.PURGE_DAYS;

const monitorWheelWins = async () => {
  try {
    const now = new Date();
    const expired = await WheelWin.find({ purgeAt: { $lte: now } });
    if (expired.length) {
      await WheelWin.deleteMany({ _id: { $in: expired.map((w) => w._id) } });
      safeLog("info", "wheel_monitor_expired_purged", { count: expired.length });
    }
  } catch (err) {
    safeLog("error", "wheel_monitor_failed", { message: err.message });
  }
};

module.exports = { monitorWheelWins, PURGE_DAYS };
