const ActivationCode = require("../models/ActivationCode");
const Store = require("../models/store");
const { atomicClaimActivationCode } = require("../utils/atomicRedeem.util");

exports.activateStore = async (req, res) => {
  try {
    if (!req.body.code?.trim()) {
      return res.status(400).json({ message: "كود التفعيل غير صالح أو مستخدم" });
    }

    const code = req.body.code.trim().toUpperCase();

    const store = await Store.findOne({ owner: req.user.id });
    if (!store) {
      return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });
    }

    const activation = await atomicClaimActivationCode(code, req.user.id);
    if (!activation) {
      return res.status(400).json({ message: "كود التفعيل غير صالح أو مستخدم" });
    }

    store.isActive = true;
    await store.save();

    res.json({ message: "تم تفعيل المتجر بنجاح" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createStoreActivationCode = async (req, res) => {
  try {
    const { accountType } = req.body;

    if (!["store", "supplier"].includes(accountType)) {
      return res.status(400).json({ message: "نوع الحساب غير صحيح (store أو supplier)" });
    }

    const code = "ACT-" + Math.random().toString(36).substring(2, 8).toUpperCase();

    const activation = await ActivationCode.create({
      code,
      role: accountType,
      isUsed: false,
    });

    res.json({
      message: "تم إنشاء كود التفعيل",
      activation,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
