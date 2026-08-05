const User = require("../models/user");
const UserSuggestion = require("../models/userSuggestion");
const Notification = require("../models/notification");
const Competition = require("../models/competition");
const StoreMembership = require("../models/storeMembership");
const PromoCode = require("../models/promoCode");
const SystemSetting = require("../models/systemSetting");
const { getProgress } = require("../utils/level.util");
const { syncUnlocks, countActiveAchievements } = require("./achievement.controller");
const { generateVerifyCode, hashVerificationSecret, verifyVerificationSecret, syncVerifiedFlag } = require("../utils/verification.util");
const verificationService = require("../services/verification.service");
const { countCompletedReferrals } = require("../services/referral.service");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { USER_SENSITIVE_SELECT, sanitizeUser } = require("../utils/userSanitize.util");
const { mergeRecentPointSources } = require("../utils/pointSources.util");

const DEFAULT_LEGAL = {
  terms: `مرحباً بك في Win GoldenStore.

باستخدامك للمنصة، فإنك توافق على الشروط والأحكام التالية. هدفنا حماية حقوق الجميع — المستخدمين والمتاجر — مع تقديم تجربة واضحة وموثوقة.

━━━ طبيعة المنصة ━━━

Win GoldenStore منصة تسويقية تربط العملاء بالمتاجر المعتمدة. نوفّر مساحة للعرض والتواصل وبرامج المكافآت، بينما يتولى كل متجر مسؤولية نشاطه التجاري بشكل مستقل.

المنصة غير مسؤولة عن:
• جودة المنتجات
• أسعار المنتجات
• الاتفاقات المالية بينك وبين المتجر
• التوصيل والشحن

تبقى هذه الأمور على عاتق كل متجر على حدة. ننصحك بالتحقق من تفاصيل العرض والتواصل مع المتجر مباشرة قبل إتمام أي شراء.

━━━ نقاط المكافأة ━━━

نقاط المكافأة هدايا ترويجية يقدّمها المتاجر المشاركة في البرنامج، وهي بمثابة تقدير لولائك وتفاعلك مع المنصة.

هذه النقاط:
• لا يمكن بيعها
• لا يمكن شراؤها
• لا يمكن استبدالها بأموال نقدية

وجودها يقتصر على كونها مكافآت تقديرية ضمن إطار المنصة، ولا تُعدّ التزاماً مالياً على المنصة أو المتاجر.

━━━ المسابقات ━━━

تُنظَّم المسابقات وفق قواعد واضحة وشفافة تُعرض عليك قبل المشاركة.

تحتفظ إدارة المنصة بحق:
• تعديل القواعد عند الضرورة
• إلغاء المسابقات
• تعليق المسابقات مؤقتاً

وذلك عند الحاجة، مع الالتزام بالعدالة وإبلاغ المستخدمين بما يقتضيه الموقف.

━━━ البطاقات والأكواد ━━━

المنصة غير مسؤولة عن:
• بطاقات النقاط المفقودة
• البطاقات التالفة
• البطاقات التي تشاركها مع أشخاص آخرين

أنت مسؤول عن حفظ بطاقاتك وأكوادك وعدم مشاركتها مع غيرك. تعامل معها كما تتعامل مع أي قسيمة شخصية قيّمة.

━━━ توافر المنصة ━━━

قد تخضع المنصة أحياناً إلى صيانة دورية أو توقف مؤقت لأسباب تقنية. نعمل دائماً على استعادة الخدمة بأسرع وقت ممكن، ونقدّر صبرك وتفهمك.

━━━ التزامنا تجاهك ━━━

نلتزم في Win GoldenStore بالعدالة والشفافية وحماية تجربتك كمستخدم. نطوّر المنصة باستمرار لنقدّم لك بيئة آمنة ومريحة للتسوّق والاستفادة من المكافآت. ثقتك تهمّنا، ونبقى إلى جانبك في رحلتك مع متاجرنا المعتمدة.`,
  privacy: `نحترم خصوصيتك في Win GoldenStore.

نجمع فقط البيانات اللازمة لتشغيل حسابك وتحسين تجربتك — مثل الاسم والبريد الإلكتروني ورقم الهاتف عند إضافته، وتفضيلاتك إن اخترت مشاركتها.

لا نبيع بياناتك الشخصية لأطراف ثالثة. لا نشارك معلوماتك إلا عند الضرورة لتقديم الخدمة أو عند وجود التزام قانوني.

تفضيلاتك (المنطقة والاهتمامات) تُستخدم لترتيب العروض المناسبة لك فقط، وليس للتتبع التجاري الخارجي.

يمكنك تحديث بياناتك من صفحة نقاطي في أي وقت. لأي استفسار حول الخصوصية، تواصل مع الدعم الفني من داخل التطبيق.`,
  disclaimer:
    "Win GoldenStore منصة تسويقية تربط العملاء بالمتاجر ولا تتدخل في التعاملات المالية أو التوصيل بينهما. الجوائز والمكافآت تُقدَّم ضمن البلد فقط ولا تُرسل خارج البلد. استخدامك للمنصة يعني موافقتك على الشروط الكاملة الواردة في تبويب «الشروط».",
};

async function getLegalContent() {
  const keys = ["legal_terms", "legal_privacy", "legal_disclaimer"];
  const docs = await SystemSetting.find({ key: { $in: keys } });
  const map = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  return {
    terms: map.legal_terms || DEFAULT_LEGAL.terms,
    privacy: map.legal_privacy || DEFAULT_LEGAL.privacy,
    disclaimer: map.legal_disclaimer || DEFAULT_LEGAL.disclaimer,
  };
}

exports.getCenter = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId)
      .populate("preferences.regionId", "name")
      .select(USER_SENSITIVE_SELECT);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    await syncUnlocks(user);
    const refreshed = await User.findById(userId)
      .populate("preferences.regionId", "name")
      .select(USER_SENSITIVE_SELECT);
    const achievementCount = await countActiveAchievements(refreshed.points || 0);

    const [referralsCount, membershipsCount, competitionsJoined, promoCount] =
      await Promise.all([
        countCompletedReferrals(userId),
        StoreMembership.countDocuments({ user: userId, status: "member" }),
        Competition.countDocuments({ "participants.user": userId }),
        PromoCode.countDocuments({ "usedBy.user": userId }),
      ]);

    const level = getProgress(refreshed.points);

    res.json({
      user: sanitizeUser(refreshed),
      level,
      stats: {
        points: refreshed.points,
        competitionsJoined,
        prizesWon: achievementCount,
        referralsCount,
        membershipsCount,
        codesUsed: refreshed.codesUsed,
        promoCodesRedeemed: promoCount,
        lastPrize: null,
      },
      legal: await getLegalContent(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    if (name?.trim()) user.name = name.trim();
    if (avatar) {
      if (typeof avatar === "string" && avatar.length > 800_000) {
        return res.status(400).json({ message: "الصورة كبيرة جداً" });
      }
      user.avatar = await processOptionalImage(avatar, { maxWidth: 400, maxBytes: 800_000 });
    }
    await user.save();
    res.json({ message: "تم التحديث", user: { name: user.name, avatar: user.avatar } });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.requestPhoneChange = async (req, res) => {
  try {
    const { newPhone } = req.body;
    if (!newPhone?.trim()) return res.status(400).json({ message: "رقم الهاتف مطلوب" });

    const phone = normalizeLocalPhone(newPhone);
    if (!isValidLocalPhone(phone)) {
      return res.status(400).json({ message: LOCAL_PHONE_MESSAGE });
    }

    const exists = await User.findOne({ phone, _id: { $ne: req.user.id } });
    if (exists) return res.status(400).json({ message: "الرقم مستخدم من قبل" });

    const code = generateVerifyCode();
    const user = await User.findById(req.user.id);
    user.phonePending = phone;
    user.phoneVerifyCode = hashVerificationSecret(code);
    user.phoneVerifyExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    try {
      await verificationService.sendPhoneChangeOtp(user, phone, code);
    } catch (sendErr) {
      user.phonePending = null;
      user.phoneVerifyCode = null;
      user.phoneVerifyExpires = null;
      await user.save();
      return res.status(sendErr.status || 503).json({ message: sendErr.message || "تعذّر إرسال SMS" });
    }

    const payload = { message: "تم إرسال رمز التحقق عبر SMS" };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.verifyPhoneChange = async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.user.id);
    if (!user?.phonePending || !user.phoneVerifyCode) {
      return res.status(400).json({ message: "لا يوجد طلب تغيير هاتف نشط" });
    }
    if (user.phoneVerifyExpires < new Date()) {
      return res.status(400).json({ message: "انتهت صلاحية الرمز — أعد الطلب" });
    }
    if (!verifyVerificationSecret(String(code).trim(), user.phoneVerifyCode)) {
      return res.status(400).json({ message: "رمز التحقق غير صحيح" });
    }

    user.phone = user.phonePending;
    user.phonePending = null;
    user.phoneVerifyCode = null;
    user.phoneVerifyExpires = null;
    user.phoneVerified = false;
    syncVerifiedFlag(user);
    await user.save();

    res.json({ message: "تم تحديث رقم الهاتف", phone: user.phone });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const { regionId, interests, storeTypes, productInterests } = req.body;
    if (!user.preferences) user.preferences = {};

    if (regionId !== undefined) user.preferences.regionId = regionId || null;
    if (interests !== undefined) user.preferences.interests = interests;
    if (storeTypes !== undefined) user.preferences.storeTypes = storeTypes;
    if (productInterests !== undefined) user.preferences.productInterests = productInterests;

    let bonusPoints = 0;
    const firstTime =
      !user.preferences.personalizationBonusAwarded &&
      (regionId || interests?.length || storeTypes?.length);
    if (firstTime) {
      user.preferences.personalizationBonusAwarded = true;
      bonusPoints = 5;
      user.points += bonusPoints;
      await syncUnlocks(user);
    }

    await user.save();
    res.json({
      message: bonusPoints ? `تم الحفظ — +${bonusPoints} نقاط هدية!` : "تم حفظ التفضيلات",
      preferences: user.preferences,
      points: user.points,
      bonusPoints,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.submitSuggestion = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "الاقتراح مطلوب" });
    await UserSuggestion.create({ user: req.user.id, message: message.trim() });
    res.status(201).json({ message: "شكراً — وصل اقتراحك للإدارة" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAdminContact = async (_req, res) => {
  try {
    const admin = await User.findOne({ role: "admin" }).select("_id name");
    if (!admin) return res.status(404).json({ message: "لا يوجد حساب إدارة" });
    res.json({ adminId: admin._id, adminName: admin.name });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.listSuggestionsAdmin = async (req, res) => {
  try {
    const { status = "new" } = req.query;
    const filter = status === "all" ? {} : { status };
    const suggestions = await UserSuggestion.find(filter)
      .populate("user", "name email phone")
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ suggestions, newCount: await UserSuggestion.countDocuments({ status: "new" }) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateSuggestionAdmin = async (req, res) => {
  try {
    const item = await UserSuggestion.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status || "read" },
      { new: true }
    );
    if (!item) return res.status(404).json({ message: "غير موجود" });
    res.json({ suggestion: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPointsLeaderboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const leaderboardQuery = { role: "customer", status: "active" };

    const [topUsers, me] = await Promise.all([
      User.find(leaderboardQuery)
        .select("name avatar points createdAt")
        .sort({ points: -1, createdAt: 1 })
        .limit(5)
        .lean(),
      User.findById(userId).select("name avatar points createdAt").lean(),
    ]);

    if (!me) return res.status(404).json({ message: "المستخدم غير موجود" });

    const aheadCount = await User.countDocuments({
      ...leaderboardQuery,
      $or: [
        { points: { $gt: me.points || 0 } },
        { points: me.points || 0, createdAt: { $lt: me.createdAt } },
      ],
    });
    const myRank = aheadCount + 1;

    const top = topUsers.map((u, index) => ({
      rank: index + 1,
      user: { _id: u._id, name: u.name, avatar: u.avatar },
      points: u.points || 0,
    }));

    res.json({
      top,
      myRank,
      myPoints: me.points || 0,
      me: {
        _id: me._id,
        name: me.name,
        avatar: me.avatar,
        points: me.points || 0,
        rank: myRank,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getLegal = async (_req, res) => {
  res.json(await getLegalContent());
};

exports.getPointSources = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

    const notifications = await Notification.find({ user: userId })
      .select("type title body data createdAt")
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();

    res.json({
      sources: mergeRecentPointSources(notifications, limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
