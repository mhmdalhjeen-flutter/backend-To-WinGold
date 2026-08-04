const auditService = require("../services/audit.service");
const { safeLog } = require("../utils/logSanitize.util");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function mapOperation(method) {
    if (method === "POST") return "create";
    if (method === "PUT" || method === "PATCH") return "update";
    if (method === "DELETE") return "delete";
    return "other";
}

function buildGenericAudit(req) {
    const pageHeader = req.headers["x-admin-page"];
    return {
        action: `عملية إدارية: ${req.method} ${req.originalUrl || req.path}`,
        details: `تنفيذ ${req.method} على ${req.path}`,
        operationType: mapOperation(req.method),
        entityType: "admin_route",
        entityName: req.path,
        page: pageHeader || "Admin Panel",
        metadata: { method: req.method, path: req.path },
    };
}

module.exports = function adminAuditMiddleware(req, res, next) {
    if (!MUTATING.has(req.method) || !req.user || req.user.role !== "admin") {
        return next();
    }

    const originalJson = res.json.bind(res);

    res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
            const payload = req.auditContext || buildGenericAudit(req);
            auditService.logAdminAction(req, payload).catch((error) => {
                safeLog("error", "admin_audit_failed", { message: error.message, path: req.originalUrl });
            });
        }
        return originalJson(body);
    };

    next();
};
