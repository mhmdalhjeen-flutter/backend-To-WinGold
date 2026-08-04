const mongoose = require("mongoose");

/**
 * طبقة نشاط المستخدم الموحّدة (AD-007).
 * تسجّل كل تفاعلات المستخدم في مكان واحد لتغذية نظام التوصيات (AD-004):
 * المشاهدات، الفتح، زيارة المتاجر، البحث، والمفضّلة.
 * meta حقل مرن يخزّن سياقاً مفيداً للتوصية (category/region/query) لتفادي
 * استعلامات إضافية وقت التوصية.
 */
const userActivitySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["view_offer", "open_offer", "view_product", "visit_store", "search", "favorite_offer"],
      required: true,
    },
    targetType: { type: String, enum: ["Offer", "Store", "Product", null], default: null },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

userActivitySchema.index({ user: 1, type: 1, createdAt: -1 });
userActivitySchema.index({ type: 1, createdAt: -1, targetId: 1 });
userActivitySchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.UserActivity ||
  mongoose.model("UserActivity", userActivitySchema);
