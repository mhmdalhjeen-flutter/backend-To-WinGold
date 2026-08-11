const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    email: {
        type: String,
        unique: true,
        sparse: true,
        lowercase: true,
        trim: true,
        
    },
    phone: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        
    },
   
    googleId: String,
    facebookId: String,
    tiktokId: String,
    provider: {
    type: String,
    enum: ["local", "google", "facebook", "tiktok"],
    default: "local",
},
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    verifyEmailCode: { type: String, default: null },
    verifyEmailLinkToken: { type: String, default: null },
    verifyEmailExpires: { type: Date, default: null },
    verifyPhoneCode: { type: String, default: null },
    verifyPhoneExpires: { type: Date, default: null },
    verificationBonusAwarded: { type: Boolean, default: false },

    password: {
    type: String,
    default: null,
    },
    
    avatar: {
        type: String,
        default: null 
    },
    points: {
        type: Number,
        default: 0,
    },
    energy: { 
        type: Number,
        default: 0,
    },
    // المتاجر التي مُنحت عنها طاقة الانضمام مسبقاً (تمنع تكرار منح الطاقة لنفس المتجر)
    storesEnergyClaimed: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store"
    }],
    // --- مخزن البطاقات الملونة ---
    inventory: {
        cards: [{
            cardType: { type: mongoose.Schema.Types.ObjectId, ref: "CardType" },
            count: { type: Number, default: 0 }
        }]
    },
    referralCode: { 
        type: String,
        unique: true,
    },
    referredBy: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null
    },
    referralRewardGranted: {
        type: Boolean,
        default: false,
    },
    referralCompletedAt: {
        type: Date,
        default: null,
    },
    entriesWallet: { 
        type: Number,
        default: 0,
    },
    codesUsed: { 
        type: Number,
        default: 0,
    },
    rank: { 
        type: String,
        enum: ["bronze", "silver", "gold", "platinum"],
        default: "bronze",
    },
    followedStores: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store"
    }],
    /** Stores where the customer opted out of product/offer notifications while keeping membership. */
    storeNotificationOptOut: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
    }],
    lastChestOpened: {
        type: Date,
        default: null
    },
    status: {
        type: String,
        enum: ["active", "suspended", "banned"],
        default: "active",
    },
    role: {
        type: String,
        enum: ["customer", "store", "supplier", "admin", "delivery_company", "delivery_driver"],
        default: "customer",
    },
    /** شركة التوصيل — لحسابات بوابة الشركة (role: delivery_company) */
    deliveryCompanyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "DeliveryCompany",
        default: null,
        index: true,
    },
    /** سجل السائق — لحسابات السائق (role: delivery_driver) */
    deliveryDriverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "DeliveryCompanyDriver",
        default: null,
        index: true,
    },
    /** true بعد أن تُنشئ الشركة كلمة المرور لأول مرة */
    portalActivated: { type: Boolean, default: false },
   

address: {
  type: String,
  default: ""
},
    preferences: {
      regionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", default: null },
      interests: { type: [String], default: [] },
      storeTypes: { type: [String], default: [] },
      productInterests: { type: [String], default: [] },
      /** تصنيفات المتاجر التي يتابعها التاجر (مورد) لعرض عروضها */
      networkCategoryIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Category", default: [] },
      personalizationBonusAwarded: { type: Boolean, default: false },
    },
    phonePending: { type: String, default: null },
    phoneVerifyCode: { type: String, default: null },
    phoneVerifyExpires: { type: Date, default: null },
    achievementUnlocks: [{
      milestone: { type: mongoose.Schema.Types.ObjectId, ref: "AchievementMilestone" },
      unlockedAt: { type: Date, default: Date.now },
      animationSeen: { type: Boolean, default: false },
    }],
    passwordResetCode: { type: String, default: null },
    passwordResetExpires: { type: Date, default: null },
    /** كلمة مرور إضافية للصفحات الحساسة (أدمن فقط) */
    sensitivePasswordHash: { type: String, default: null },
    /** يُرفع عند تغيير كلمة المرور/الحظر/تسجيل الخروج لإبطال JWTs الصادرة سابقاً */
    tokenVersion: { type: Number, default: 0 },
    /** يُرفع مع tokenVersion عند logout لإبطال refresh tokens */
    refreshTokenVersion: { type: Number, default: 0 },
    /** جلسات نشطة مربوطة بـ deviceId */
    sessions: [{
        deviceId: { type: String, required: true },
        refreshTokenHash: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date, default: Date.now },
    }],
}, {
    timestamps: true,
});

userSchema.pre("validate", function () {
    const hasIdentity = this.email || this.phone || this.googleId || this.facebookId || this.tiktokId;
    if (!hasIdentity) {
        throw new Error("يجب توفير البريد الإلكتروني أو رقم الهاتف على الأقل");
    }

    if (!this.referralCode) {
        this.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    }
});

userSchema.pre("save", function () {
    if (this.isModified("codesUsed")) {
        if (this.codesUsed >= 100) this.rank = "platinum";
        else if (this.codesUsed >= 50) this.rank = "gold";
        else if (this.codesUsed >= 10) this.rank = "silver";
        else this.rank = "bronze";
    }
    if (this.isModified("emailVerified") || this.isModified("phoneVerified")) {
        this.isVerified = Boolean(
            (this.email && this.emailVerified) ||
            (this.phone && this.phoneVerified)
        );
    }
});

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ role: 1, points: -1, createdAt: -1 });
userSchema.index({ followedStores: 1 });
userSchema.index({ storeNotificationOptOut: 1 });
userSchema.index({ referredBy: 1, referralRewardGranted: 1 });
userSchema.index({ status: 1 });

module.exports = mongoose.models.user || mongoose.model("User", userSchema);
