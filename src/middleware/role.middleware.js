const auditService = require("../services/audit.service");

const roleMiddleware = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!roles.includes(req.user.role)) {
      auditService.logSecurityEvent(req, {
        action: "انتهاك صلاحيات الدور",
        details: `الدور "${req.user.role}" حاول الوصول — مطلوب: ${roles.join(", ")}`,
        severity: "warning",
        metadata: {
          requiredRoles: roles,
          path: req.originalUrl || req.path,
          method: req.method,
        },
      }).catch(() => {});

      return res.status(403).json({ message: "You do not have permission to access this resource" });
    }

    next();
  };
};

/** Pre-built role guards — single source of truth for route authorization */
roleMiddleware.admin = roleMiddleware(["admin"]);
roleMiddleware.customer = roleMiddleware(["customer"]);
roleMiddleware.store = roleMiddleware(["store"]);
roleMiddleware.supplier = roleMiddleware(["supplier"]);
roleMiddleware.business = roleMiddleware(["store", "supplier"]);
roleMiddleware.businessOrAdmin = roleMiddleware(["store", "supplier", "admin"]);

module.exports = roleMiddleware;
