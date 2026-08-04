const ExcelJS = require("exceljs");
const ActivityLog = require("../../models/ActivityLog");
const User = require("../../models/user");
const { cleanString, requireObjectId, safeRegex } = require("../../utils/inputSecurity.util");

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

function buildDateFilter(from, to) {
    const filter = {};
    if (from) {
        const start = new Date(cleanString(from, { field: "from", max: 40 }));
        if (Number.isNaN(start.getTime())) throw Object.assign(new Error("from غير صالح"), { status: 400 });
        filter.$gte = start;
    }
    if (to) {
        const end = new Date(cleanString(to, { field: "to", max: 40 }));
        if (Number.isNaN(end.getTime())) throw Object.assign(new Error("to غير صالح"), { status: 400 });
        end.setHours(23, 59, 59, 999);
        filter.$lte = end;
    }
    return Object.keys(filter).length ? filter : null;
}

function buildQuery(params = {}) {
    const {
        category,
        severity,
        operationType,
        entityType,
        adminId,
        search,
        from,
        to,
        success,
    } = params;

    const query = {};

    const safeCategory = cleanString(category, { field: "category", max: 40 });
    const safeSeverity = cleanString(severity, { field: "severity", max: 20 });
    const safeOperationType = cleanString(operationType, { field: "operationType", max: 40 });
    const safeEntityType = cleanString(entityType, { field: "entityType", max: 60 });

    if (safeCategory) {
        if (!["admin_login", "admin_audit", "security", "platform"].includes(safeCategory)) {
            throw Object.assign(new Error("category غير صالح"), { status: 400 });
        }
        query.category = safeCategory;
    }
    if (safeSeverity) {
        if (!["info", "warning", "danger"].includes(safeSeverity)) {
            throw Object.assign(new Error("severity غير صالح"), { status: 400 });
        }
        query.severity = safeSeverity;
    }
    if (safeOperationType) query.operationType = safeOperationType;
    if (safeEntityType) query.entityType = safeEntityType;
    if (adminId) query.user = requireObjectId(adminId, "adminId");
    if (success === "true") query.success = true;
    if (success === "false") query.success = false;

    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) query.createdAt = dateFilter;

    const searchText = cleanString(search, { field: "search", max: 100 });
    if (searchText) {
        const term = safeRegex(searchText, { field: "search", max: 100 });
        query.$or = [
            { action: term },
            { details: term },
            { adminName: term },
            { adminEmail: term },
            { entityName: term },
            { page: term },
            { ipAddress: term },
        ];
    }

    return query;
}

async function paginatedLogs(query, { page = 1, limit = PAGE_SIZE_DEFAULT }) {
    const safeLimit = Math.min(Math.max(Number(limit) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [items, total] = await Promise.all([
        ActivityLog.find(query)
            .populate("user", "name email role")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean(),
        ActivityLog.countDocuments(query),
    ]);

    return {
        items,
        total,
        page: safePage,
        pages: Math.ceil(total / safeLimit) || 1,
        limit: safeLimit,
    };
}

exports.getActivityLogs = async (req, res) => {
    try {
        const query = buildQuery({
            ...req.query,
            category: req.query.category || "admin_audit",
        });
        if (!req.query.category) {
            query.category = { $in: ["admin_audit", "platform"] };
        }

        const result = await paginatedLogs(query, req.query);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.getLoginLogs = async (req, res) => {
    try {
        const query = buildQuery({ ...req.query, category: "admin_login" });
        const result = await paginatedLogs(query, req.query);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.getSecurityLogs = async (req, res) => {
    try {
        const query = buildQuery({
            ...req.query,
            category: req.query.category || undefined,
        });
        if (!req.query.category) {
            query.$or = [
                { category: "security" },
                { severity: { $in: ["warning", "danger"] } },
            ];
        }

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [result, failedLogins24h, securityAlerts24h, successfulLogins24h] = await Promise.all([
            paginatedLogs(query, req.query),
            ActivityLog.countDocuments({
                category: "admin_login",
                success: false,
                createdAt: { $gte: since24h },
            }),
            ActivityLog.countDocuments({
                category: "security",
                createdAt: { $gte: since24h },
            }),
            ActivityLog.countDocuments({
                category: "admin_login",
                success: true,
                createdAt: { $gte: since24h },
            }),
        ]);

        const suspiciousIps = await ActivityLog.aggregate([
            {
                $match: {
                    category: "admin_login",
                    success: false,
                    createdAt: { $gte: since24h },
                    ipAddress: { $exists: true, $ne: null },
                },
            },
            { $group: { _id: "$ipAddress", count: { $sum: 1 } } },
            { $match: { count: { $gte: 3 } } },
            { $count: "total" },
        ]);

        res.json({
            ...result,
            stats: {
                failedLogins24h,
                securityAlerts24h,
                successfulLogins24h,
                suspiciousIpCount: suspiciousIps[0]?.total || 0,
                activeSessionsEstimate: successfulLogins24h,
                lastScanAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.getAuditFilters = async (_req, res) => {
    try {
        const admins = await User.find({ role: "admin" }).select("name email").lean();
        const entityTypes = await ActivityLog.distinct("entityType");
        const operationTypes = await ActivityLog.distinct("operationType");

        res.json({
            admins,
            entityTypes: entityTypes.filter(Boolean),
            operationTypes: operationTypes.filter(Boolean),
            categories: ["admin_login", "admin_audit", "security", "platform"],
            severities: ["info", "warning", "danger"],
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getLogById = async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const log = await ActivityLog.findById(id)
            .populate("user", "name email role")
            .lean();
        if (!log) return res.status(404).json({ message: "السجل غير موجود" });
        res.json(log);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

function formatLogRow(log) {
    return {
        التاريخ: log.createdAt ? new Date(log.createdAt).toLocaleString("ar-EG") : "",
        الفئة: log.category || "",
        العملية: log.action || "",
        النوع: log.operationType || "",
        الكيان: log.entityType || "",
        اسم_العنصر: log.entityName || "",
        المعرف: log.entityId || "",
        الأدمن: log.adminName || log.user?.name || "",
        البريد: log.adminEmail || log.user?.email || "",
        IP: log.ipAddress || "",
        الجهاز: log.device || "",
        المتصفح: log.browser || "",
        النظام: log.os || "",
        الموقع: log.location || "",
        الصفحة: log.page || "",
        الحالة: log.success === false ? "فاشل" : "ناجح",
        سبب_الفشل: log.failureReason || "",
        الخطورة: log.severity || "",
        التفاصيل: log.details || "",
        القيم_القديمة: log.oldValues ? JSON.stringify(log.oldValues) : "",
        القيم_الجديدة: log.newValues ? JSON.stringify(log.newValues) : "",
    };
}

exports.exportLogs = async (req, res) => {
    try {
        const format = cleanString(req.query.format || "xlsx", { field: "format", max: 10 });
        const type = cleanString(req.query.type || "activity", { field: "type", max: 20 });
        const { from, to } = req.query;
        if (!["xlsx", "csv", "pdf"].includes(format)) {
            return res.status(400).json({ message: "format غير صالح" });
        }
        if (!["activity", "login", "security"].includes(type)) {
            return res.status(400).json({ message: "type غير صالح" });
        }
        const categoryMap = {
            activity: { $in: ["admin_audit", "platform"] },
            login: "admin_login",
            security: { $in: ["security", "admin_login"] },
        };

        const query = buildQuery({ ...req.query, from, to });
        query.category = categoryMap[type] || categoryMap.activity;

        const logs = await ActivityLog.find(query)
            .populate("user", "name email")
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean();

        const rows = logs.map(formatLogRow);

        if (format === "csv") {
            const headers = Object.keys(rows[0] || formatLogRow({}));
            const csvLines = [
                headers.join(","),
                ...rows.map((row) =>
                    headers.map((h) => `"${String(row[h] || "").replace(/"/g, '""')}"`).join(",")
                ),
            ];
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="audit-${type}-${Date.now()}.csv"`);
            return res.send(`\uFEFF${csvLines.join("\n")}`);
        }

        if (format === "pdf") {
            const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
              <title>سجل التدقيق</title>
              <style>
                body{font-family:Arial,sans-serif;padding:24px;font-size:11px}
                h1{font-size:18px;margin-bottom:8px}
                table{width:100%;border-collapse:collapse}
                th,td{border:1px solid #ccc;padding:6px;text-align:right;vertical-align:top}
                th{background:#f3f4f6}
              </style></head><body>
              <h1>سجل التدقيق — ${type}</h1>
              <p>عدد السجلات: ${rows.length} | الفترة: ${from || "—"} → ${to || "—"}</p>
              <table><thead><tr>${Object.keys(rows[0] || formatLogRow({})).map((h) => `<th>${h}</th>`).join("")}</tr></thead>
              <tbody>${rows.map((row) => `<tr>${Object.values(row).map((v) => `<td>${String(v || "").replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join("")}</tbody>
              </table></body></html>`;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="audit-${type}-${Date.now()}.html"`);
            return res.send(html);
        }

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Audit Log");
        const headers = Object.keys(rows[0] || formatLogRow({}));
        sheet.addRow(headers);
        rows.forEach((row) => sheet.addRow(headers.map((h) => row[h] || "")));
        sheet.getRow(1).font = { bold: true };

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="audit-${type}-${Date.now()}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};
