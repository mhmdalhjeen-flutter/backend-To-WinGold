const mongoose = require("mongoose");

/**
 * تصنيف هرمي قابل للتوسع (AD-005).
 * الهرمية عبر مرجع ذاتي `parent` (null = مستوى أعلى)، ويدعم 3 مستويات أو أكثر.
 * متوافق خلفياً: التصنيفات القديمة (بلا parent) تُعتبر مستوى أعلى تلقائياً.
 */
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      // ملاحظة: أُزيلت قيود unique العالمية للسماح بتكرار الاسم تحت آباء مختلفين.
    },
    description: { type: String },
    icon: { type: String, default: "" },

    // الأب في الهرمية (null = جذر/مستوى أعلى).
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },

    // ترتيب العرض داخل نفس المستوى.
    order: { type: Number, default: 0 },

    /** أولوية عرض يدوية من الأدمن — null = الترتيب الحالي (order + الاسم) */
    displayPriority: { type: Number, default: null },

    type: {
      type: String,
      enum: ["store", "product"],
      default: "store",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// فهرس لتسريع جلب أبناء أب معيّن.
categorySchema.index({ parent: 1, isActive: 1 });

module.exports =
  mongoose.models.Category || mongoose.model("Category", categorySchema);
