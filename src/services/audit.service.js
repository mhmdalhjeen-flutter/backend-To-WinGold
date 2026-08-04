const ActivityLog = require("../models/ActivityLog");
const { getClientIp, parseUserAgent, approximateLocation } = require("../utils/requestMeta.util");
const { maskIdentifier, safeLog, sanitizeForLog } = require("../utils/logSanitize.util");

const FAILED_LOGIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUSPICIOUS_THRESHOLD = 5;

function extractRequestMeta(req) {
    const ua = req.headers["user-agent"] || "";
    const parsed = parseUserAgent(ua);
    const ip = getClientIp(req);
    return {
        ipAddress: ip,
        userAgent: ua,
        device: parsed.device,
        browser: parsed.browser,
        os: parsed.os,
        location: approximateLocation(ip),
    };
}

async function writeLog(payload) {
    try {
        await ActivityLog.create(sanitizeForLog(payload));
    } catch (error) {
        safeLog("error", "audit_write_failed", { message: error.message });
    }
}

async function checkSuspiciousLogin(ipAddress, identifier) {
    if (!ipAddress) return;
    const since = new Date(Date.now() - FAILED_LOGIN_WINDOW_MS);
    const count = await ActivityLog.countDocuments({
        category: { $in: ["admin_login", "security"] },
        action: "محاولة تسجيل دخول فاشلة",
        success: false,
        ipAddress,
        createdAt: { $gte: since },
    });

    if (count >= SUSPICIOUS_THRESHOLD) {
        await writeLog({
            category: "security",
            action: "نشاط مشبوه: محاولات دخول فاشلة متكررة",
            details: `${count} محاولات فاشلة من IP ${ipAddress}${identifier ? ` للحساب ${maskIdentifier(identifier)}` : ""}`,
            severity: "danger",
            operationType: "access",
            entityType: "security_alert",
            ipAddress,
            success: false,
            metadata: { failedAttempts: count, identifier: maskIdentifier(identifier) },
        });
    }
}

async function logAuthAttempt(req, {
    success,
    identifier,
    user = null,
    appType = null,
    failureReason = null,
}) {
    const meta = extractRequestMeta(req);
    const resolvedAppType = appType || req.body?.appType || (user?.role === "admin" ? "admin" : user?.role) || "unknown";
    const isAdminAttempt = resolvedAppType === "admin" || user?.role === "admin";

    await writeLog({
        category: isAdminAttempt ? "admin_login" : "security",
        action: success ? "تسجيل دخول ناجح" : "محاولة تسجيل دخول فاشلة",
        details: success
            ? `دخول ناجح (${resolvedAppType}): ${maskIdentifier(user?.email || user?.name || identifier)}`
            : `فشل الدخول (${resolvedAppType}): ${maskIdentifier(identifier)}${failureReason ? ` — ${failureReason}` : ""}`,
        user: user?._id || null,
        adminName: user?.name || maskIdentifier(identifier) || "—",
        adminEmail: user?.email || (identifier?.includes("@") ? maskIdentifier(identifier) : null),
        success: !!success,
        failureReason: failureReason || undefined,
        operationType: "login",
        entityType: "auth_session",
        page: resolvedAppType === "admin" ? "Admin Login" : "Login",
        severity: success ? "info" : "danger",
        metadata: { appType: resolvedAppType },
        ...meta,
    });

    if (!success) {
        await checkSuspiciousLogin(meta.ipAddress, identifier);
    }
}

async function logAdminLogin(req, {
    success,
    identifier,
    user = null,
    failureReason = null,
}) {
    return logAuthAttempt(req, {
        success,
        identifier,
        user,
        appType: "admin",
        failureReason,
    });
}

async function logSecurityEvent(req, {
    action,
    details,
    severity = "warning",
    user = null,
    metadata = {},
}) {
    const meta = req ? extractRequestMeta(req) : {};
    let actor = user;
    if (actor && !actor.name && actor._id) {
        actor = { name: actor.name, email: actor.email, _id: actor._id };
    }
    if (!actor?.name && req?.userDoc) actor = req.userDoc;
    if (!actor?.name && req?.user?.id) {
        const User = require("../models/user");
        actor = await User.findById(req.user.id).select("name email").lean();
    }

    await writeLog({
        category: "security",
        action,
        details: sanitizeForLog(details),
        user: actor?._id || req?.user?.id || null,
        adminName: actor?.name,
        adminEmail: actor?.email,
        severity,
        operationType: "access",
        entityType: "security_alert",
        page: metadata.page || "Security",
        metadata: sanitizeForLog(metadata),
        success: false,
        ...meta,
    });
}

async function logSensitiveOperation(req, {
    action,
    details,
    user = null,
    metadata = {},
    success = true,
}) {
    const meta = req ? extractRequestMeta(req) : {};
    await writeLog({
        category: "security",
        action,
        details: sanitizeForLog(details),
        user: user?._id || req?.user?.id || null,
        adminName: user?.name,
        adminEmail: user?.email,
        severity: success ? "info" : "warning",
        operationType: "sensitive",
        entityType: "sensitive_operation",
        metadata: sanitizeForLog(metadata),
        success,
        ...meta,
    });
}

async function logAdminAction(req, {
    action,
    details,
    operationType = "other",
    entityType,
    entityId,
    entityName,
    page,
    oldValues,
    newValues,
    severity = "info",
    store = null,
    metadata = {},
}) {
    const meta = extractRequestMeta(req);
    const admin = req.userDoc || null;

    await writeLog({
        category: "admin_audit",
        action,
        details: sanitizeForLog(details),
        user: req.user?.id || null,
        adminName: admin?.name || req.user?.name,
        adminEmail: admin?.email || req.user?.email,
        store,
        operationType,
        entityType: entityType || undefined,
        entityId: entityId ? String(entityId) : undefined,
        entityName,
        page,
        oldValues: sanitizeForLog(oldValues),
        newValues: sanitizeForLog(newValues),
        severity,
        metadata: sanitizeForLog(metadata),
        success: true,
        ...meta,
    });
}

async function logActivity(data) {
    await writeLog({
        category: data.category || "platform",
        action: data.action,
        details: sanitizeForLog(data.details),
        user: data.user || null,
        store: data.store || null,
        severity: data.severity || "info",
        ipAddress: data.ipAddress || null,
    });
}

function attachAuditFromContext(req, res) {
    if (req.method === "GET" || !req.user || req.user.role !== "admin") return;

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 400 && req.auditContext) {
            logAdminAction(req, req.auditContext).catch((error) => {
                safeLog("error", "admin_audit_failed", { message: error.message, path: req.originalUrl });
            });
        }
        return originalJson(body);
    };
}

module.exports = {
    logActivity,
    logAuthAttempt,
    logAdminLogin,
    logAdminAction,
    logSecurityEvent,
    logSensitiveOperation,
    extractRequestMeta,
    attachAuditFromContext,
    writeLog,
};
