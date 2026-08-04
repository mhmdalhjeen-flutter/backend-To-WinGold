const auditService = require("../services/audit.service");

/** @deprecated prefer auditService.logAdminAction for admin ops */
module.exports = auditService.logActivity;
