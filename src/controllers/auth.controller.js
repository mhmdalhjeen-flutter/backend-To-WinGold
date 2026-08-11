const bcrypt = require("bcryptjs");
const User = require("../models/user");
const ActivationCode = require("../models/ActivationCode");
const Store = require("../models/store");
const { assignUniqueStorePrefix } = require("../utils/storePrefix");
const { resolveRegionPath, resolveCategoryPath } = require("../utils/hierarchyResolve.util");
const { OAuth2Client } = require("google-auth-library");
const {
  isUserVerified,
  getVerificationPolicy,
  syncVerifiedFlag,
  awardVerificationBonus,
} = require("../utils/verification.util");
const {
  assertUserNotBlocked,
  sanitizeUser,
  USER_SENSITIVE_SELECT,
} = require("../utils/userSanitize.util");
const verificationService = require("../services/verification.service");
const platformSettings = require("../services/platformSettings.service");
const { isCustomerExperienceRole } = require("../constants/customerExperience.constants");
const auditService = require("../services/audit.service");
const tokenService = require("../services/token.service");
const { safeLog } = require("../utils/logSanitize.util");
const {
  assertAuthBody,
  cleanAuthIdentifier,
  cleanAuthPassword,
  cleanAppType,
  cleanVerificationChannel,
  cleanOtpCode,
} = require("../utils/authValidation.util");
const { assertNoMongoOperators, cleanString } = require("../utils/inputSecurity.util");
const registrationOtp = require("../utils/registrationOtp.util");

async function buildAuthResponse(user, req, extra = {}) {
  const deviceId = tokenService.extractDeviceId(req) || req.body?.deviceId;
  const tokens = await tokenService.issueTokenPair(user, { deviceId });
  const fresh = await User.findById(user._id || user.id).select(USER_SENSITIVE_SELECT);
  return {
    message: extra.message,
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    deviceId: tokens.deviceId,
    user: sanitizeUser(fresh || user),
    ...extra.payload,
  };
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const {
  normalizeLocalPhone,
  isValidLocalPhone,
  normalizeWhatsApp,
  isValidWhatsApp,
  resolveRegistrationPhone,
  LOCAL_PHONE_MESSAGE,
  WHATSAPP_MESSAGE,
} = require("../utils/phone.util");

// ================= REGISTER CUSTOMER =================
const registerCustomer = async (req, res) => {
  try {
    assertAuthBody(req.body, "register");
    const {
      name,
      email,
      phone,
      password,
      referralCode,
    } = req.body;

    const cleanName = cleanString(name, { field: "name", max: 120, required: true });
    const cleanPassword = cleanAuthPassword(password);

    const cleanEmail = email ? cleanString(email, { field: "email", max: 120 }).toLowerCase() : undefined;
    let cleanPhone;
    if (phone) {
      ({ localPhone: cleanPhone } = resolveRegistrationPhone(phone));
    }
    const cleanReferral = referralCode ? cleanString(referralCode, { field: "referralCode", max: 20 }) : undefined;

    if (cleanEmail && !isValidEmail(cleanEmail)) {
      return res.status(400).json({ message: "صيغة البريد الإلكتروني غير صحيحة" });
    }

    if (!cleanEmail && !cleanPhone) {
      return res.status(400).json({ message: "يجب إدخال بريد إلكتروني أو رقم هاتف" });
    }

    if (cleanPhone) {
      const phoneVerified = await registrationOtp.isPhoneVerifiedForRegistration(cleanPhone);
      if (!phoneVerified) {
        return res.status(400).json({
          message: "يجب التحقق من رقم الهاتف عبر OTP قبل إنشاء الحساب",
          code: "PHONE_NOT_VERIFIED",
        });
      }
    }

    // 2. التحقق من وجود المستخدم مسبقاً
    const existingUser = await User.findOne({
      $or: [
        cleanEmail ? { email: cleanEmail } : null,
        cleanPhone ? { phone: cleanPhone } : null
      ].filter(Boolean)
    });

    if (existingUser) {
      return res.status(400).json({
        message: "هذا الحساب موجود مسبقاً"
      });
    }

    // 3. إنشاء المستخدم (زبون فقط)
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);

    const { resolveReferrer } = require("../services/referral.service");
    const referrer = await resolveReferrer(cleanReferral);

    const user = await User.create({
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      password: hashedPassword,
      role: "customer",
      emailVerified: false,
      phoneVerified: Boolean(cleanPhone),
      isVerified: Boolean(cleanPhone),
      referredBy: referrer?._id || null,
    });

    if (cleanPhone) {
      await registrationOtp.consumePhoneVerification(cleanPhone);
    }

    const response = await buildAuthResponse(user, req, {
      message: "تم إنشاء حساب الزبون بنجاح",
    });

    return res.status(201).json(response);

  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "هذا الحساب موجود مسبقاً" });
    }
    return res.status(error.status || 500).json({
      message: error.message || "حدث خطأ أثناء إنشاء الحساب"
    });
  }
};

const registerBusiness = async (req, res) => {
  try {
    assertAuthBody(req.body, "registerBusiness");
    const {
      name,
      phone,
      password,
      accountType, // store or supplier (اختياري للمقارنة فقط)
      activationCodeSS,
      businessName,
      businessType,
      mainLocation,
      subLocation,
      regionPath,
      categoryPath,
      networkCategoryPath,
      whatsapp,
    } = req.body;

    const regionPathIds = Array.isArray(regionPath) ? regionPath.filter(Boolean) : [];
    const categoryPathIds = Array.isArray(categoryPath) ? categoryPath.filter(Boolean) : [];
    const networkCategoryPathIds = Array.isArray(networkCategoryPath)
      ? networkCategoryPath.filter(Boolean)
      : [];

    // 1. التحقق من البيانات الأساسية
    if (!name || !phone || !password || !activationCodeSS || !businessName?.trim()) {
      return res.status(400).json({
        message: "البيانات غير مكتملة",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "كلمة المرور يجب أن تكون 6 أحرف على الأقل",
      });
    }

    const cleanPhone = normalizeLocalPhone(phone);
    if (!isValidLocalPhone(cleanPhone)) {
      return res.status(400).json({ message: LOCAL_PHONE_MESSAGE });
    }

    let cleanWhatsapp = null;
    if (whatsapp?.trim()) {
      cleanWhatsapp = normalizeWhatsApp(whatsapp);
      if (!isValidWhatsApp(cleanWhatsapp)) {
        return res.status(400).json({ message: WHATSAPP_MESSAGE });
      }
    }

    // 2. التحقق من المستخدم
    const existingUser = await User.findOne({ phone: cleanPhone });
    if (existingUser) {
      return res.status(400).json({
        message: "هذا الحساب موجود مسبقاً",
      });
    }

    // 3. التحقق من كود التفعيل
    const activation = await ActivationCode.findOne({
      code: activationCodeSS,
      isUsed: false,
      $or: [
        { expiresAt: null },
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    });

    if (!activation) {
      return res.status(400).json({
        message: "كود التفعيل غير صالح أو مستخدم",
      });
    }

    // 4. تحديد الدور الحقيقي من الكود (الأهم)
    const roleFromCode = activation.role; // supplier | store

    // 5. التحقق من تطابق اختيار الواجهة مع الكود
    if (accountType && accountType !== roleFromCode) {
      return res.status(400).json({
        message: `نوع الحساب غير متطابق مع كود التفعيل (${roleFromCode})`,
      });
    }

    // 6. التحقق من بيانات المتجر قبل إنشاء المستخدم حتى لا يترك فشل التسجيل حساباً يتيماً.
    let regionData = null;
    let categoryData = null;

    if (regionPathIds.length) {
      regionData = await resolveRegionPath(regionPathIds);
      if (!regionData) {
        return res.status(400).json({ message: "مسار المنطقة غير صالح" });
      }
    } else if (mainLocation) {
      regionData = {
        region: mainLocation,
        subRegion: subLocation || mainLocation,
        regionId: null,
        subRegionId: null,
      };
    } else {
      return res.status(400).json({ message: "اختر المنطقة (المستوى الأول إلزامي)" });
    }

    if (roleFromCode === "supplier" && !networkCategoryPathIds.length) {
      return res.status(400).json({
        message: "اختر تصنيفات المتاجر التي تتابعها (المستوى الأول إلزامي للتاجر)",
      });
    }

    if (categoryPathIds.length) {
      categoryData = await resolveCategoryPath(categoryPathIds);
      if (!categoryData) {
        return res.status(400).json({ message: "مسار نوع المتجر غير صالح" });
      }
    } else if (businessType?.trim()) {
      categoryData = { category: businessType.trim(), categoryId: null };
    } else {
      return res.status(400).json({ message: "اختر نوع المتجر (المستوى الأول إلزامي)" });
    }

    // 7. إنشاء المستخدم
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      phone: cleanPhone,
      password: hashedPassword,
      role: roleFromCode,
      preferences: roleFromCode === "supplier" && networkCategoryPathIds.length
        ? { networkCategoryIds: networkCategoryPathIds }
        : undefined,
    });

    const codePrefix = await assignUniqueStorePrefix(businessName || name);
    const store = await Store.create({
      name: businessName,
      phone: cleanPhone,
      whatsapp: cleanWhatsapp,
      category: categoryData.category,
      categoryId: categoryData.categoryId,
      region: regionData.region,
      subRegion: regionData.subRegion,
      regionId: regionData.regionId,
      subRegionId: regionData.subRegionId,
      owner: user._id,
      isActive: true,
      codePrefix,
    });

    // 8. تحديث كود التفعيل
    activation.isUsed = true;
    activation.usedBy = user._id;
    activation.storeName = businessName;
    await activation.save();

    const response = await buildAuthResponse(user, req, {
      message: "تم إنشاء الحساب بنجاح",
      payload: {
        store,
        redirectTo: roleFromCode === "supplier" ? "/supplier" : "/store",
      },
    });

    return res.status(201).json(response);

  } catch (error) {
    return res.status(500).json({
      message: error.message,
    });
  }
};



// ================= LOGIN =================

const login = async (req, res) => {
  try {
    assertAuthBody(req.body, "login");
    const identifier = cleanAuthIdentifier(req.body.identifier);
    const password = cleanAuthPassword(req.body.password);
    const appType = cleanAppType(req.body.appType);

    const logAttempt = async (success, reason, userDoc = null) => {
      await auditService.logAuthAttempt(req, {
        success,
        identifier: identifier?.trim() || "—",
        user: userDoc,
        appType,
        failureReason: reason,
      });
    };

    const cleanIdentifier = identifier;
    const isEmailLogin = cleanIdentifier.includes("@");
    const emailLookup = isEmailLogin ? cleanIdentifier.toLowerCase() : undefined;
    const phoneLookup = !isEmailLogin ? normalizeLocalPhone(cleanIdentifier) : undefined;

    const user = await User.findOne({
      $or: [
        emailLookup ? { email: emailLookup } : null,
        phoneLookup ? { phone: phoneLookup } : null,
      ].filter(Boolean),
    });

    if (!user) {
      await logAttempt(false, "حساب غير موجود");
      return res.status(400).json({
        message: "بيانات الدخول غير صحيحة"
      });
    }

    if (!user.password) {
      if (appType === "delivery" && user.role === "delivery_company" && !user.portalActivated) {
        await logAttempt(false, "حساب بانتظار التفعيل");
        return res.status(403).json({
          message: "الحساب لم يُفعّل بعد — أنشئ كلمة المرور من شاشة التفعيل",
          code: "PORTAL_NOT_ACTIVATED",
        });
      }
      await logAttempt(false, "حساب بدون كلمة مرور");
      return res.status(400).json({
        message: "هذا الحساب لا يدعم تسجيل الدخول بكلمة المرور"
      });
    }

    if (appType === "delivery" && user.role === "delivery_company" && !user.portalActivated) {
      await logAttempt(false, "حساب بانتظار التفعيل");
      return res.status(403).json({
        message: "الحساب لم يُفعّل بعد — أنشئ كلمة المرور من شاشة التفعيل",
        code: "PORTAL_NOT_ACTIVATED",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      await logAttempt(false, "كلمة مرور خاطئة");
      return res.status(400).json({
        message: "بيانات الدخول غير صحيحة"
      });
    }

    if (user.status === "banned" || user.status === "suspended") {
      await logAttempt(false, user.status === "banned" ? "حساب محظور" : "حساب موقوف");
      return res.status(403).json({
        message: user.status === "banned" ? "تم حظر حسابك — تواصل مع الدعم" : "تم تعليق حسابك مؤقتاً",
        code: "ACCOUNT_BLOCKED",
      });
    }

    if (appType) {
      if (appType === "customer" && !isCustomerExperienceRole(user.role)) {
        await logAttempt(false, "دور غير متطابق — تطبيق زبائن", user);
        return res.status(403).json({
          message: "هذا الحساب غير مخصص لتطبيق الزبائن"
        });
      }

      if (appType === "business" && !["store", "supplier"].includes(user.role)) {
        await logAttempt(false, "دور غير متطابق — تطبيق تجار", user);
        return res.status(403).json({
          message: "هذا الحساب غير مخصص لتطبيق التجار"
        });
      }

      if (appType === "admin" && user.role !== "admin") {
        await logAttempt(false, "دور غير مصرح", user);
        return res.status(403).json({
          message: "غير مصرح بالدخول"
        });
      }

      if (appType === "delivery" && !["delivery_company", "delivery_driver"].includes(user.role)) {
        await logAttempt(false, "دور غير متطابق — بوابة التوصيل", user);
        return res.status(403).json({
          message: "هذا الحساب غير مخصص لبوابة التوصيل"
        });
      }

      if (appType === "delivery" && user.role === "delivery_company" && !user.portalActivated) {
        await logAttempt(false, "حساب بانتظار التفعيل");
        return res.status(403).json({
          message: "الحساب لم يُفعّل بعد — أنشئ كلمة المرور من شاشة التفعيل",
          code: "PORTAL_NOT_ACTIVATED",
        });
      }

      if (appType === "delivery" && user.role === "delivery_company" && !user.deliveryCompanyId) {
        await logAttempt(false, "شركة غير مربوطة", user);
        return res.status(403).json({
          message: "حساب الشركة غير مربوط بشركة توصيل — تواصل مع الإدارة"
        });
      }

      if (appType === "delivery" && user.role === "delivery_driver") {
        if (!user.deliveryDriverId) {
          await logAttempt(false, "سائق غير مربوط", user);
          return res.status(403).json({
            message: "حساب السائق غير مربوط — تواصل مع شركة التوصيل"
          });
        }
        const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
        const driverRecord = await DeliveryCompanyDriver.findById(user.deliveryDriverId).select("isActive");
        if (!driverRecord?.isActive) {
          await logAttempt(false, "سائق معطّل", user);
          return res.status(403).json({
            message: "حساب السائق معطّل — تواصل مع شركة التوصيل"
          });
        }
      }
    }

    const maintenance = await platformSettings.getMaintenanceInfo();
    if (maintenance.enabled && user.role !== "admin") {
      return res.status(503).json({
        message: maintenance.message,
        code: "MAINTENANCE_MODE",
        maintenanceMode: true,
      });
    }

    await logAttempt(true, null, user);

    const response = await buildAuthResponse(user, req, {
      message: "تم تسجيل الدخول بنجاح",
    });

    return res.json(response);

  } catch (err) {
    return res.status(500).json({
      message: err.message || "حدث خطأ أثناء تسجيل الدخول"
    });
  }
};


// ================= RESET ADMIN PASSWORD =================
const resetAdminPassword = async (req, res) => {
    try {
        const { masterKey, newPassword } = req.body;

        // يجب أن يكون MASTER_KEY مضبوطاً في البيئة، وإلا تُعطّل العملية بالكامل
        // (يمنع ثغرة: undefined !== undefined التي كانت تسمح بتجاوز التحقق)
        if (!process.env.MASTER_KEY || !masterKey || masterKey !== process.env.MASTER_KEY) {
            return res.status(401).json({
                message: "خطأ في المفتاح"
            });
        }

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({
                message: "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل"
            });
        }

        const admin = await User.findOne({ role: "admin" });

        if (!admin) {
            return res.status(404).json({
                message: "الأدمن غير موجود"
            });
        }

        admin.password = await bcrypt.hash(newPassword, 10);
        await tokenService.invalidateAllUserTokens(admin, { revokeSensitive: true });

        res.json({ message: "تم تحديث كلمة المرور" });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


const googleAuth = async (req, res) => {
  try {
    const { credential, referralCode } = req.body;

    if (!credential) {
      return res.status(400).json({ message: "No credential provided" });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ message: "Google OAuth غير مهيّأ" });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.sub) {
      return res.status(400).json({ message: "رمز Google غير صالح" });
    }

    const email = payload.email?.trim()?.toLowerCase();
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ message: "البريد الإلكتروني غير متوفر من Google" });
    }

    const name = payload.name || "مستخدم Google";
    const picture = payload.picture;
    const googleId = payload.sub;

    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
    }

    if (!user) {
      const cleanReferral = referralCode
        ? cleanString(referralCode, { field: "referralCode", max: 20 })
        : undefined;
      const { resolveReferrer } = require("../services/referral.service");
      const referrer = await resolveReferrer(cleanReferral);

      user = await User.create({
        name,
        email,
        avatar: picture,
        googleId,
        provider: "google",
        role: "customer",
        password: null,
        emailVerified: !!payload.email_verified,
        isVerified: !!payload.email_verified,
        referredBy: referrer?._id || null,
      });
      if (payload.email_verified) {
        await awardVerificationBonus(user);
      }
    } else {
      if (!user.googleId) user.googleId = googleId;
      if (payload.email_verified && !user.emailVerified) {
        user.emailVerified = true;
        syncVerifiedFlag(user);
        await awardVerificationBonus(user);
      }
      await user.save();
      assertUserNotBlocked(user);
    }

    const response = await buildAuthResponse(user, req);
    return res.json(response);
  } catch (error) {
    if (error.status === 403) {
      return res.status(403).json({ message: error.message, code: error.code });
    }
    safeLog("error", "google_auth_failed", { message: error.message });
    return res.status(500).json({ message: "Google authentication failed" });
  }
};

const facebookAuth = async (req, res) => {
  try {
    const { accessToken, referralCode } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: "رمز Facebook مطلوب" });
    }

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(503).json({ message: "Facebook OAuth غير مهيّأ" });
    }

    const appAccessToken = `${appId}|${appSecret}`;
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appAccessToken)}`
    );
    const debugPayload = await debugRes.json();

    if (!debugPayload?.data?.is_valid || String(debugPayload.data.app_id) !== String(appId)) {
      return res.status(401).json({ message: "رمز Facebook غير صالح أو منتهٍ" });
    }

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(accessToken)}`
    );
    const profile = await profileRes.json();

    if (profile?.error || !profile?.id) {
      return res.status(400).json({
        message: profile?.error?.message || "فشل التحقق من Facebook",
      });
    }

    const facebookId = String(profile.id);
    const email = profile.email?.trim()?.toLowerCase();
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: "البريد الإلكتروني من Facebook غير صالح" });
    }

    const facebookOwner = await User.findOne({ facebookId });
    if (facebookOwner) {
      assertUserNotBlocked(facebookOwner);
      const response = await buildAuthResponse(facebookOwner, req);
      return res.json(response);
    }

    let user = email ? await User.findOne({ email }) : null;

    if (user) {
      if (user.facebookId && user.facebookId !== facebookId) {
        return res.status(400).json({ message: "هذا الحساب مرتبط بFacebook آخر" });
      }
      user.facebookId = facebookId;
      if (!user.avatar && profile.picture?.data?.url) {
        user.avatar = profile.picture.data.url;
      }
      if (!user.name?.trim() && profile.name) {
        user.name = profile.name;
      }
      syncVerifiedFlag(user);
      await user.save();
      assertUserNotBlocked(user);
    } else {
      const cleanReferral = referralCode
        ? cleanString(referralCode, { field: "referralCode", max: 20 })
        : undefined;
      const { resolveReferrer } = require("../services/referral.service");
      const referrer = await resolveReferrer(cleanReferral);

      user = await User.create({
        name: profile.name || "مستخدم Facebook",
        email: email || undefined,
        avatar: profile.picture?.data?.url,
        facebookId,
        provider: "facebook",
        role: "customer",
        password: null,
        emailVerified: false,
        phoneVerified: false,
        isVerified: false,
        referredBy: referrer?._id || null,
      });
      assertUserNotBlocked(user);
    }

    const response = await buildAuthResponse(user, req);
    return res.json(response);
  } catch (error) {
    if (error.status === 403) {
      return res.status(403).json({ message: error.message, code: error.code });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: "هذا الحساب موجود مسبقاً" });
    }
    safeLog("error", "facebook_auth_failed", { message: error.message });
    return res.status(500).json({ message: "فشل تسجيل الدخول عبر Facebook" });
  }
};

const tiktokAuth = async (req, res) => {
  try {
    const { accessToken: bodyAccessToken, code, redirectUri } = req.body;

    if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
      return res.status(503).json({ message: "TikTok OAuth غير مهيّأ" });
    }

    let accessToken = bodyAccessToken || null;

    if (code) {
      const uri = redirectUri || process.env.TIKTOK_REDIRECT_URI;
      if (!uri) {
        return res.status(400).json({ message: "redirectUri مطلوب" });
      }
      const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: uri,
        }).toString(),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error || !tokenData.access_token) {
        return res.status(400).json({
          message: tokenData.error_description || "فشل تبادل رمز TikTok",
        });
      }
      accessToken = tokenData.access_token;
    }

    if (!accessToken) {
      return res.status(400).json({ message: "رمز TikTok مطلوب للتحقق" });
    }

    const infoRes = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const info = await infoRes.json();
    const tiktokUser = info?.data?.user;

    if (!infoRes.ok || !tiktokUser?.open_id) {
      return res.status(400).json({ message: "فشل التحقق من TikTok" });
    }

    const tiktokId = tiktokUser.open_id;
    const name = tiktokUser.display_name || "مستخدم TikTok";
    const avatar = tiktokUser.avatar_url || null;

    let user = await User.findOne({ tiktokId });
    if (!user) {
      user = await User.create({
        name,
        avatar,
        tiktokId,
        provider: "tiktok",
        role: "customer",
        password: null,
        emailVerified: false,
        phoneVerified: false,
        isVerified: false,
      });
    } else {
      assertUserNotBlocked(user);
    }

    const response = await buildAuthResponse(user, req);
    return res.json(response);
  } catch (error) {
    if (error.status === 403) {
      return res.status(403).json({ message: error.message, code: error.code });
    }
    safeLog("error", "tiktok_auth_failed", { message: error.message });
    return res.status(500).json({ message: "فشل تسجيل الدخول عبر TikTok" });
  }
};

const logout = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "المستخدم غير موجود" });
    }

    await tokenService.invalidateAllUserTokens(user, {
      revokeSensitive: user.role === "admin",
    });

    return res.json({ message: "تم تسجيل الخروج وإبطال الجلسة" });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

const refresh = async (req, res) => {
  try {
    assertAuthBody(req.body, "refresh");
    const refreshToken = cleanString(req.body.refreshToken, { field: "refreshToken", max: 4096, required: true });
    const deviceId = req.body.deviceId ? cleanString(req.body.deviceId, { field: "deviceId", max: 64 }) : undefined;
    if (!refreshToken) {
      return res.status(400).json({ message: "refreshToken مطلوب", code: "REFRESH_MISSING" });
    }

    const decoded = tokenService.verifyJwt(refreshToken);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "Invalid refresh token", code: "REFRESH_INVALID" });
    }

    if (user.status === "banned" || user.status === "suspended") {
      return res.status(403).json({
        message: user.status === "banned" ? "تم حظر حسابك" : "تم تعليق حسابك",
        code: "ACCOUNT_BLOCKED",
      });
    }

    const tokens = await tokenService.refreshTokenPair(user, refreshToken, {
      deviceId: deviceId || tokenService.extractDeviceId(req),
    });

    const fresh = await User.findById(user._id).select(USER_SENSITIVE_SELECT);
    return res.json({
      message: "تم تجديد الجلسة",
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      deviceId: tokens.deviceId,
      user: sanitizeUser(fresh || user),
    });
  } catch (err) {
    return res.status(err.status || 401).json({
      message: err.message || "Refresh token invalid",
      code: err.code || "REFRESH_INVALID",
    });
  }
};

const requestVerification = async (req, res) => {
  try {
    assertAuthBody(req.body, "verify");
    const channel = cleanVerificationChannel(req.body.channel);
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    let result;
    if (channel === "email") {
      result = await verificationService.sendEmailVerification(user);
    } else if (channel === "phone") {
      result = await verificationService.sendPhoneVerification(user);
    } else {
      return res.status(400).json({ message: "قناة التحقق غير صالحة" });
    }

    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

const confirmVerification = async (req, res) => {
  try {
    assertAuthBody(req.body, "verify");
    const channel = cleanVerificationChannel(req.body.channel);
    const code = cleanOtpCode(req.body.code);
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    if (channel === "email") {
      await verificationService.confirmEmailCode(user, code);
    } else if (channel === "phone") {
      await verificationService.confirmPhoneCode(user, code);
    } else {
      return res.status(400).json({ message: "قناة التحقق غير صالحة" });
    }

    const bonusPoints = await verificationService.finalizeVerification(user);

    const fresh = await User.findById(user._id).select(USER_SENSITIVE_SELECT);
    return res.json({
      message: bonusPoints ? `تم التوثيق — +${bonusPoints} نقاط هدية!` : "تم توثيق حسابك",
      user: sanitizeUser(fresh || user),
      bonusPoints,
      points: user.points,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

const confirmEmailLink = async (req, res) => {
  try {
    const { uid, token } = req.query;
    if (!uid || !token) {
      return res.status(400).json({ message: "رابط التفعيل غير مكتمل" });
    }

    const { user, alreadyVerified } = await verificationService.confirmEmailLink(uid, token);
    let bonusPoints = 0;

    if (!alreadyVerified) {
      bonusPoints = await verificationService.finalizeVerification(user);
    }

    return res.json({
      message: alreadyVerified
        ? "البريد موثّق مسبقاً"
        : bonusPoints
          ? `تم توثيق بريدك — +${bonusPoints} نقاط هدية!`
          : "تم توثيق بريدك الإلكتروني",
      user: sanitizeUser(user),
      bonusPoints,
      points: user.points,
      alreadyVerified: !!alreadyVerified,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

const getVerificationStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "email phone emailVerified phoneVerified isVerified verificationBonusAwarded points"
    );
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
    return res.json({
      email: user.email,
      phone: user.phone,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      isVerified: isUserVerified(user),
      verificationBonusAwarded: user.verificationBonusAwarded,
      points: user.points,
      ...getVerificationPolicy(),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};


const checkDeliveryPortalPhone = async (req, res) => {
  try {
    assertAuthBody(req.body, "deliveryCheck");
    const phone = normalizeLocalPhone(cleanString(req.body.phone, { field: "phone", max: 32, required: true }));
    if (!phone) {
      return res.status(400).json({ message: "رقم الهاتف غير صالح" });
    }

    const user = await User.findOne({ phone, role: "delivery_company" });
    if (!user) {
      return res.status(404).json({
        message: "رقم الهاتف غير مسجل — تواصل مع الإدارة",
        exists: false,
        activated: false,
      });
    }

    return res.json({
      exists: true,
      activated: Boolean(user.portalActivated),
      message: user.portalActivated
        ? "الحساب مفعّل — استخدم تسجيل الدخول"
        : "يمكنك تفعيل حسابك الآن",
    });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};

const verifyDriverRegistrationPassword = async (req, res) => {
  try {
    const deliveryDriverService = require("../services/deliveryDriver.service");
    const result = await deliveryDriverService.verifyDriverRegistrationPassword(
      req.body?.registrationPassword,
    );
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }
};

const registerDeliveryDriver = async (req, res) => {
  try {
    const deliveryDriverService = require("../services/deliveryDriver.service");
    const { user, companyName } = await deliveryDriverService.registerDriver(req.body);
    const response = await buildAuthResponse(user, req, {
      message: `تم التسجيل بنجاح — ${companyName}`,
    });
    return res.status(201).json(response);
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }
};

const activateDeliveryPortal = async (req, res) => {
  try {
    assertAuthBody(req.body, "deliveryActivate");
    const phone = normalizeLocalPhone(cleanString(req.body.phone, { field: "phone", max: 32, required: true }));
    const password = cleanAuthPassword(req.body.password);
    const confirmPassword = cleanAuthPassword(req.body.confirmPassword, { field: "confirmPassword" });

    if (!phone) {
      return res.status(400).json({ message: "رقم الهاتف غير صالح" });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ message: "كلمتا المرور غير متطابقتين" });
    }

    const user = await User.findOne({ phone, role: "delivery_company" });
    if (!user) {
      return res.status(404).json({ message: "رقم الهاتف غير مسجل — تواصل مع الإدارة" });
    }
    if (user.portalActivated) {
      return res.status(400).json({
        message: "الحساب مفعّل مسبقاً — سجّل الدخول",
        code: "ALREADY_ACTIVATED",
      });
    }
    if (!user.deliveryCompanyId) {
      return res.status(400).json({ message: "حساب الشركة غير مربوط — تواصل مع الإدارة" });
    }
    if (user.status === "banned" || user.status === "suspended") {
      return res.status(403).json({ message: "تم تعليق هذا الحساب — تواصل مع الإدارة" });
    }

    user.password = await bcrypt.hash(password, 10);
    user.portalActivated = true;
    await user.save();

    const response = await buildAuthResponse(user, req, {
      message: "تم تفعيل الحساب بنجاح",
    });
    return res.json(response);
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
};


module.exports = {
  registerCustomer,
  registerBusiness,
  login,
  logout,
  refresh,
  resetAdminPassword,
  googleAuth,
  facebookAuth,
  tiktokAuth,
  requestVerification,
  confirmVerification,
  confirmEmailLink,
  getVerificationStatus,
  checkDeliveryPortalPhone,
  activateDeliveryPortal,
  verifyDriverRegistrationPassword,
  registerDeliveryDriver,
  buildAuthResponse,
};