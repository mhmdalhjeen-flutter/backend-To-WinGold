const platformSettings = require("../services/platformSettings.service");

exports.getPublic = async (_req, res) => {
  try {
    const settings = await platformSettings.getPublicSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** صلاحيات صفحات لوحة صاحب المحل فقط — لا تُعرض في الإعدادات العامة للزبون */
exports.getStoreOwnerPages = async (_req, res) => {
  try {
    const storeOwnerPages = await platformSettings.getStoreOwnerPageSettings();
    res.json({ storeOwnerPages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
