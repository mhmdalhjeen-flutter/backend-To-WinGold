const monthlyCycleSimulationService = require("../../services/monthlyCycleSimulation.service");
const { addMonthsToMonthKey } = require("../../utils/subscriptionMonth.util");

exports.getSimulationStatus = async (_req, res) => {
  try {
    const cursorMonthKey = await monthlyCycleSimulationService.getSimulationCursorMonthKey();
    res.json({
      cursorMonthKey,
      nextSimulationTargetMonthKey: addMonthsToMonthKey(cursorMonthKey, 1),
      note: "أداة اختبار — لا تغيّر ساعة النظام",
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.runMonthlyCycleSimulation = async (req, res) => {
  try {
    const summary = await monthlyCycleSimulationService.runMonthlyCycleSimulation(req.user?.id);
    res.json(summary);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
