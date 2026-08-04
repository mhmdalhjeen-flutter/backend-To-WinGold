const platformSettings = require("../services/platformSettings.service");

/**
 * يمنع أصحاب المتاجر (role=store) فقط من الوصول لصفحة معطّلة في لوحة التاجر.
 * لا يؤثر على الزبائن (customer) ولا على الموردين (supplier) ولا على الواجهة العامة.
 */
function requireStoreOwnerPage(page) {
  return async (req, res, next) => {
    try {
      if (!req.user || req.user.role !== "store") {
        return next();
      }
      const pages = await platformSettings.getStoreOwnerPageSettings();
      if (pages[page] === false) {
        return res.status(403).json({
          message: "هذه الصفحة غير متاحة حالياً — تواصل مع إدارة المنصة",
          code: "STORE_PAGE_DISABLED",
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireStoreOwnerPage };
