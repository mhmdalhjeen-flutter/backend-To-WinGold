const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema({
    category: {
        type: String,
        enum: ["platform", "admin_login", "admin_audit", "security"],
        default: "platform",
        index: true,
    },
    action: {
        type: String,
        required: true,
    },
    details: {
        type: String,
        required: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
    },
    adminName: { type: String },
    adminEmail: { type: String },
    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
    },
    ipAddress: { type: String, index: true },
    userAgent: { type: String },
    device: { type: String },
    browser: { type: String },
    os: { type: String },
    location: { type: String },
    severity: {
        type: String,
        enum: ["info", "warning", "danger"],
        default: "info",
        index: true,
    },
    success: { type: Boolean, default: true },
    failureReason: { type: String },
    operationType: {
        type: String,
        enum: ["create", "update", "delete", "enable", "disable", "login", "logout", "access", "export", "other"],
    },
    entityType: { type: String, index: true },
    entityId: { type: String },
    entityName: { type: String },
    page: { type: String },
    oldValues: { type: mongoose.Schema.Types.Mixed },
    newValues: { type: mongoose.Schema.Types.Mixed },
    metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ category: 1, createdAt: -1 });

const IMMUTABLE_MSG = "سجلات التدقيق غير قابلة للتعديل أو الحذف";

["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"].forEach((op) => {
    activityLogSchema.pre(op, function blockMutations() {
        throw new Error(IMMUTABLE_MSG);
    });
});

module.exports = mongoose.model("ActivityLog", activityLogSchema);
