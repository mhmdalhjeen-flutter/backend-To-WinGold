const dns = require('dns');
dns.setServers(['8.8.4.4', '8.8.8.8']);

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const { isExcelExportRequest } = require("./src/utils/excelDownload.util");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");

const connectDB = require("./src/config/db");
const { connectRedis } = require("./src/config/redis");
const { ensureSchemaIndexes } = require("./src/config/syncIndexes");
const User = require("./src/models/user");
const { backfillStorePrefixes } = require("./src/utils/storePrefix");
const { backfillReferralRewardFlags } = require("./src/services/referral.service");
const { createApiRouter } = require("./src/routes/registerApiRoutes");
const { createV1Router } = require("./src/routes/v1");
const uploadRoutes = require("./src/routes/upload.routes");
const rateLimit = require("./src/middleware/rateLimit.middleware");
const requestLogMiddleware = require("./src/middleware/requestLog.middleware");
const auditService = require("./src/services/audit.service");
const { safeLog } = require("./src/utils/logSanitize.util");
const { startServerHealthMonitoring } = require("./src/utils/serverHealth.util");
const {
    softThrottleMiddleware,
    gracefulDegradationMiddleware,
} = require("./src/middleware/loadResilience.middleware");

const isPrimaryWorker = () => {
    const instance = process.env.NODE_APP_INSTANCE;
    return instance === undefined || instance === "0";
};

const monitorOffers = require("./src/utils/offerMonitor");
const monitorCompetitions = require("./src/utils/competitionMonitor");
const monitorBazaar = require("./src/utils/bazaarMonitor");
const { monitorStoreSubscriptions } = require("./src/utils/storeSubscriptionMonitor");
const { monitorDeliveryBilling } = require("./src/utils/deliveryBillingMonitor");
const { monitorDriverConfirmations } = require("./src/utils/deliveryDriverConfirmationMonitor");
const { logVapidStartupStatus } = require("./src/config/vapid");

dotenv.config();

if (!process.env.JWT_SECRET) {
    safeLog("error", "startup_config_error", { message: "JWT_SECRET is required" });
    process.exit(1);
}

const app = express();
const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");

if (process.env.TRUST_PROXY) {
    const trustProxy = process.env.TRUST_PROXY === "true"
        ? 1
        : Number.isFinite(Number(process.env.TRUST_PROXY))
            ? Number(process.env.TRUST_PROXY)
            : process.env.TRUST_PROXY;
    app.set("trust proxy", trustProxy);
}

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const DEFAULT_DEV_ORIGINS = [5173, 5174, 5175].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
]);
const DEFAULT_PROD_ORIGINS = [
    "https://wingolgmoll.com",
    "https://winzor.netlify.app",
    "https://win-gold-moll.pages.dev",
    "https://win-gold-shopping.mhmdalhjeen.workers.dev",
    "https://winzor-customer.mhmdalhjeen.workers.dev",
    "https://win-gold-supplier.pages.dev",
    "https://adminwingold.pages.dev",
    "https://delivery-win-gold.pages.dev",
];

const envOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

const allowedOrigins = [...new Set([
    ...envOrigins,
    ...(isProduction ? DEFAULT_PROD_ORIGINS : DEFAULT_DEV_ORIGINS), //
])];

if (envOrigins.length === 0) {
    const message = "CORS_ORIGINS غير مضبوط";
    if (isProduction) {
        safeLog("warn", "startup_config_warning", { message, mode: "production", behavior: "production frontend origins rejected unless listed in CORS_ORIGINS" });
    } else {
        safeLog("warn", "startup_config_warning", { message, mode: "development", behavior: "localhost origins allowed" });
    }
}

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    frameguard: { action: "deny" },
    hsts: isProduction
        ? { maxAge: 15552000, includeSubDomains: true }
        : false,
    referrerPolicy: { policy: "no-referrer" },
}));

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) {
            return cb(null, true);
        }
        if (allowedOrigins.includes(origin)) {
            return cb(null, true);
        }
        if (!isProduction && LOCALHOST_ORIGIN_RE.test(origin)) {
            return cb(null, true);
        }
        if (!isProduction && envOrigins.length === 0) {
            return cb(null, true);
        }
        return cb(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "x-sensitive-token", "x-device-id", "x-client-id"],
    exposedHeaders: ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    maxAge: 600,
    optionsSuccessStatus: 204,
}));
app.use(compression({
    threshold: 1024,
    level: 6,
    filter: (req, res) => {
        if (isExcelExportRequest(req) || res.getHeader("X-No-Compression") === "1") {
            return false;
        }
        return compression.filter(req, res);
    },
}));
app.use(express.json({ limit: "3mb" }));
app.use(requestLogMiddleware);

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
    message: "طلبات كثيرة جداً، يرجى المحاولة لاحقاً",
});
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 300,
    message: "طلبات أدمن كثيرة جداً، يرجى المحاولة لاحقاً",
});
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 60,
    message: "محاولات رفع كثيرة جداً، يرجى المحاولة لاحقاً",
});
const uploadWriteLimiter = (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    return uploadLimiter(req, res, next);
};

app.use("/api/admin", adminLimiter);
[
    "/api/products",
    "/api/offers",
    "/api/stores",
    "/api/bazaar",
    "/api/chats",
    "/api/users",
    "/api/honor",
    "/api/admin/achievements",
    "/api/v1/products",
    "/api/v1/offers",
    "/api/v1/stores",
    "/api/v1/bazaar",
    "/api/v1/chats",
    "/api/v1/users",
    "/api/v1/honor",
    "/api/v1/admin/achievements",
    "/api/upload",
].forEach((path) => app.use(path, uploadWriteLimiter));
app.use("/api", apiLimiter);
app.use(softThrottleMiddleware);
app.use(gracefulDegradationMiddleware);

const maintenanceMiddleware = require("./src/middleware/maintenance.middleware");
app.use(maintenanceMiddleware);

/* ================= API ROUTES ================= */
app.use("/api/upload", uploadRoutes);

// Canonical versioned API (envelope on meta/pricing-preview only for now)
app.use("/api/v1", createV1Router());

// Legacy proxy — same handlers, unchanged response shapes (backward compatible)
app.use("/api", createApiRouter());

/* ================= SEED ADMIN ================= */
const seedAdmin = async () => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminEmail || !adminPassword) {
            safeLog("warn", "seed_admin_skipped", { reason: "ADMIN_EMAIL or ADMIN_PASSWORD missing" });
            return;
        }

        if (adminPassword.length < 8) {
            safeLog("warn", "seed_admin_skipped", { reason: "ADMIN_PASSWORD too short" });
            return;
        }

        const existing = await User.findOne({ email: adminEmail });
        if (existing) return;

        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        await User.create({
            name: "مدير المنصة",
            email: adminEmail,
            password: hashedPassword,
            role: "admin",
            status: "active"
        });

        safeLog("info", "seed_admin_created");
    } catch (err) {
        safeLog("error", "seed_admin_error", { message: err.message });
    }
};

/* ================= HOME ================= */
app.get("/", (req, res) => {
    res.send("Offers Tech API Running 🚀");
});

/* ================= 404 + ERROR HANDLER ================= */
app.use((req, res) => {
    res.status(404).json({ message: "المسار غير موجود" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || (err.message === "Origin not allowed by CORS" ? 403 : 500);
    const event = status >= 500 ? "server_error" : "request_error";

    safeLog(status >= 500 ? "error" : "warn", event, {
        message: err.message,
        status,
        method: req.method,
        path: req.originalUrl,
        stack: isProduction ? undefined : err.stack,
    });

    if (err.message === "Origin not allowed by CORS" || err.type === "entity.too.large") {
        auditService.logSecurityEvent(req, {
            action: err.message === "Origin not allowed by CORS" ? "CORS origin rejected" : "Request body rejected",
            details: err.message === "Origin not allowed by CORS"
                ? "تم رفض Origin غير مصرح به"
                : "تم رفض جسم طلب كبير أو غير صالح",
            severity: "warning",
            metadata: {
                status,
                path: req.originalUrl,
                origin: req.headers.origin,
                contentLength: req.headers["content-length"],
            },
        }).catch(() => {});
    }

    res.status(status).json({ message: status >= 500 ? "حدث خطأ في الخادم" : (err.message || "حدث خطأ في الخادم") });
});

/* ================= START SERVER ================= */
const startServer = async () => {
    try {
        await connectDB();
        await connectRedis();
        logVapidStartupStatus();

        if (isPrimaryWorker()) {
            await ensureSchemaIndexes();
            await backfillStorePrefixes();
            await backfillReferralRewardFlags();
            await seedAdmin();
        }

        startServerHealthMonitoring();

        if (isPrimaryWorker()) {
            monitorOffers();
            monitorBazaar();
            monitorCompetitions();
            monitorStoreSubscriptions();
            monitorDeliveryBilling();
            monitorDriverConfirmations();

            setInterval(() => {
                monitorOffers();
                monitorBazaar();
                monitorStoreSubscriptions();
                monitorDeliveryBilling();
            }, 24 * 60 * 60 * 1000);

            setInterval(() => {
                monitorDriverConfirmations();
            }, 60 * 60 * 1000);

            setInterval(() => {
                monitorCompetitions();
            }, 5 * 60 * 1000);
        }

        const PORT = process.env.PORT || 5000;

        app.listen(PORT, () => {
            safeLog("info", "server_started", {
                port: PORT,
                compression: "enabled",
                jsonBodyLimit: "3mb",
                apiV1: `/api/v1`,
                legacyApi: `/api`,
                worker: process.env.NODE_APP_INSTANCE ?? "single",
                pid: process.pid,
            });
        });

    } catch (err) {
        safeLog("error", "server_start_failed", { message: err.message, stack: isProduction ? undefined : err.stack });
        process.exit(1);
    }
};

startServer();
