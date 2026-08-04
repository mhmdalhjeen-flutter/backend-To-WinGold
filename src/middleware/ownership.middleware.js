const Store = require("../models/store");
const auditService = require("../services/audit.service");
const { requireObjectId } = require("../utils/inputSecurity.util");

function isAdmin(req) {
  return req.user?.role === "admin";
}

function logOwnershipViolation(req, details, metadata = {}) {
  auditService.logSecurityEvent(req, {
    action: "انتهاك ملكية المورد",
    details,
    severity: "warning",
    metadata: { ...metadata, path: req.originalUrl || req.path, method: req.method },
  }).catch(() => {});
}
/**
 * Verify that req.body.store belongs to the authenticated user.
 * Admins may target any store.
 */
async function requireBodyStoreOwnership(req, res, next) {
  try {
    if (isAdmin(req)) return next();

    const storeId = requireObjectId(req.body.store, "store");
    if (!storeId) {
      return res.status(400).json({ message: "المتجر مطلوب" });
    }

    const store = await Store.findById(storeId).select("_id owner codePrefix");
    if (!store) {
      return res.status(404).json({ message: "المتجر غير موجود" });
    }
    if (store.owner.toString() !== req.user.id.toString()) {
      logOwnershipViolation(req, "محاولة الوصول لمتجر لا ينتمي للمستخدم", { storeId: String(storeId) });
      return res.status(403).json({ message: "غير مسموح — هذا المتجر لا ينتمي لحسابك" });
    }
    req.store = store;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Attach the caller's store to req.store or reject if none exists.
 * Admins skip attachment (no personal store required).
 */
async function attachOwnStore(req, res, next) {
  try {
    if (isAdmin(req)) return next();

    const store = await Store.findOne({ owner: req.user.id });
    if (!store) {
      return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });
    }

    req.store = store;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Verify that a resource (offer, product, etc.) belongs to the caller's store.
 * Admins bypass ownership checks.
 */
function requireOwnedStoreResource(Model, paramKey = "id", notFoundMessage = "غير موجود") {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();

      const resourceId = requireObjectId(req.params[paramKey], paramKey);
      const resource = await Model.findById(resourceId).select("store");
      if (!resource) {
        return res.status(404).json({ message: notFoundMessage });
      }

      const store = await Store.findOne({ owner: req.user.id });
      if (!store || resource.store.toString() !== store._id.toString()) {
        logOwnershipViolation(req, "محاولة الوصول لمورد متجر آخر", {
          resourceId: String(resourceId),
        });
        return res.status(403).json({ message: "غير مسموح" });
      }
      req.store = store;
      req.ownedResource = resource;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Verify store param belongs to caller (unless admin).
 */
function requireParamStoreOwnership(paramKey = "storeId") {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();

      const storeId = requireObjectId(req.params[paramKey], paramKey);
      const store = await Store.findById(storeId).select("_id owner");
      if (!store) {
        return res.status(404).json({ message: "المتجر غير موجود" });
      }
      if (store.owner.toString() !== req.user.id.toString()) {
        logOwnershipViolation(req, "محاولة الوصول لمتجر عبر param", { storeId: String(storeId) });
        return res.status(403).json({ message: "غير مسموح" });
      }
      req.store = store;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Block access unless the URL param userId matches the authenticated user.
 * Admins bypass.
 */
function requireSelfOrAdmin(paramKey = "userId") {
  return (req, res, next) => {
    if (isAdmin(req)) return next();

    const targetId = req.params[paramKey];
    if (!targetId || targetId.toString() !== req.user.id.toString()) {
      logOwnershipViolation(req, "محاولة الوصول لبيانات مستخدم آخر", { targetUserId: String(targetId) });
      return res.status(403).json({ message: "غير مسموح — لا يمكنك الوصول لبيانات مستخدم آخر" });
    }
    next();
  };
}

module.exports = {
  requireBodyStoreOwnership,
  attachOwnStore,
  requireOwnedStoreResource,
  requireParamStoreOwnership,
  requireSelfOrAdmin,
};
