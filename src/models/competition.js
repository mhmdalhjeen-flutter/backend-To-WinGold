const mongoose = require("mongoose");

/**
 * نظام المسابقات (Competition)
 * مستقل تماماً عن نظام Draw/Entries الحالي (القرار AD-002).
 * يعتمد على النقاط فقط: كل (pointsPerEntry) نقطة = مشاركة واحدة،
 * وإنفاق نقاط أكثر يزيد عدد المشاركات (وبالتالي الحظ).
 * يديره الأدمن بالكامل، ويُعرض منه اثنتان مميزتان (isFeatured) في الصفحة الرئيسية.
 */
const competitionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    // رابط الصورة (مبدئياً URL؛ يُربط لاحقاً بـ Cloudinary حسب AD-003 عبر طبقة تخزين).
    image: { type: String, default: "" },

    // الحد الأدنى من النقاط ليكون المستخدم مؤهلاً للمشاركة.
    minPoints: { type: Number, default: 0, min: 0 },

    // تكلفة المشاركة الواحدة بالنقاط (كل كم نقطة = مشاركة).
    pointsPerEntry: { type: Number, default: 100, min: 1 },

    // العدد المطلوب من المشاركين لبدء المسابقة (لشريط التقدّم).
    requiredParticipants: { type: Number, default: 0, min: 0 },

    location: { type: String, default: "" },

    startDate: { type: Date },
    endDate: { type: Date },

    // الجائزة وربط السحب (يُعرضان بعد انتهاء المسابقة).
    prizeName: { type: String, default: "" },
    prizeImage: { type: String, default: "" },
    drawLink: { type: String, default: "" },
    drawNotificationSent: { type: Boolean, default: false },

    // المسابقات المعروضة في الصفحة الرئيسية (حتى اثنتين).
    isFeatured: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["draft", "active", "ended"],
      default: "active",
    },

    participants: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        entriesCount: { type: Number, default: 1, min: 1 },
        pointsSpent: { type: Number, default: 0 },
        joinedAt: { type: Date, default: Date.now },
        lastJoinedAt: { type: Date, default: Date.now },
      },
    ],

    // مجموع المشاركات (مرجّح: أكبر = حظ أكبر مستقبلاً عند اختيار الفائز).
    totalEntries: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

competitionSchema.virtual("participantsCount").get(function () {
  return this.participants ? this.participants.length : 0;
});

competitionSchema.index({ status: 1, isFeatured: -1, createdAt: -1 });
competitionSchema.index({ "participants.user": 1 });
competitionSchema.index({ drawNotificationSent: 1, endDate: 1, status: 1 });

module.exports =
  mongoose.models.Competition || mongoose.model("Competition", competitionSchema);
