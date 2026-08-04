const PromoCode = require("../../models/promoCode");
const User = require("../../models/user");
const Store = require("../../models/store");
const Category = require("../../models/category");
const Region = require("../../models/region");
const DrawBatch = require("../../models/drawBatch");
const SystemSetting = require("../../models/systemSetting");
const platformSettings = require("../../services/platformSettings.service");
const tokenService = require("../../services/token.service");
const ActivityLog = require("../../models/ActivityLog");
const CardType = require("../../models/cardType");
const TreasureBox = require("../../models/treasureBox");
const crypto = require("crypto");
const logActivity = require("../../utils/logger");
const { generatePromoCodeString } = require("../../utils/promoCode.util");
const { USER_SENSITIVE_SELECT, sanitizeUser } = require("../../utils/userSanitize.util");
const {
    assertNoMongoOperators,
    cleanString,
    intInRange,
    numberInRange,
    requireObjectId,
    safeRegex,
} = require("../../utils/inputSecurity.util");

const STORE_LIST_SELECT =
    "name phone whatsapp region subRegion category logo isActive owner cards bypassCards customersCount codesEntered createdAt";
const CODE_LIST_SELECT =
    "code store rewardPoints rewardEntries isRegistrationCode registrationRole batchName isActive maxUses currentUses createdAt";

function stripBase64StoreImages(store) {
    if (!store || typeof store !== "object") return store;
    const plain = { ...store };
    if (typeof plain.logo === "string" && plain.logo.startsWith("data:")) {
        plain.hasLogo = true;
        plain.logo = null;
    }
    return plain;
}

// 1. إحصائيات لوحة التحكم الشاملة
exports.getStats = async (req, res) => {
    try {
        const [u, s, p, c, d, ct, tb] = await Promise.all([
            User.countDocuments({ role: 'customer' }),
            Store.countDocuments({ isActive: true }),
            Store.countDocuments({ isActive: false }),
            PromoCode.countDocuments({ currentUses: { $gt: 0 }, isRegistrationCode: false }),
            DrawBatch.countDocuments({ status: { $in: ['open', 'quorum_reached', 'active'] } }),
            CardType.countDocuments({ isActive: true }),
            TreasureBox.countDocuments({ isActive: true })
        ]);
        res.status(200).json({ totalUsers: u, activeStores: s, pendingStores: p, totalCodesUsed: c, activeDraws: d, totalCardsProduced: ct, activeBoxes: tb });
    } catch (error) { res.status(500).json({ message: "خطأ في جلب الإحصائيات", error: error.message }); }
};

// 2. إدارة المستخدمين
exports.searchUsers = async (req, res) => {
    try {
        const query = cleanString(req.query.query, { field: "query", max: 80 });
        if (query.length < 2) return res.status(400).json({ message: "أدخل حرفين على الأقل للبحث" });
        const rx = safeRegex(query, { field: "query", max: 80 });
        const users = await User.find({
            $or: [
                { name: rx },
                { email: rx },
            ],
        })
            .select(USER_SENSITIVE_SELECT)
            .limit(20);
        res.status(200).json(users.map(sanitizeUser));
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

exports.updateUserManually = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "بيانات المستخدم");
        const { userId, points, entriesWallet, rank, status, codesUsed } = req.body;
        const safeUserId = requireObjectId(userId, "userId");
        const user = await User.findById(safeUserId);
        if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
        if (points !== undefined) user.points = intInRange(points, { field: "points", min: 0, max: 1_000_000 });
        if (entriesWallet !== undefined) user.entriesWallet = intInRange(entriesWallet, { field: "entriesWallet", min: 0, max: 1_000_000 });
        if (codesUsed !== undefined) user.codesUsed = intInRange(codesUsed, { field: "codesUsed", min: 0, max: 1_000_000 });
        if (rank !== undefined) {
            const safeRank = cleanString(rank, { field: "rank", max: 20 });
            if (!["bronze", "silver", "gold", "platinum"].includes(safeRank)) {
                return res.status(400).json({ message: "rank غير صالح" });
            }
            user.rank = safeRank;
        }
        if (status !== undefined) {
            const safeStatus = cleanString(status, { field: "status", max: 20 });
            if (!["active", "suspended", "banned"].includes(safeStatus)) {
                return res.status(400).json({ message: "status غير صالح" });
            }
            user.status = safeStatus;
            if (safeStatus === "banned" || safeStatus === "suspended") {
                await tokenService.invalidateAllUserTokens(user);
                return res.status(200).json({ message: "تم تحديث البيانات بنجاح", user: sanitizeUser(user) });
            }
        }
        await user.save();
        res.status(200).json({ message: "تم تحديث البيانات بنجاح", user: sanitizeUser(user) });
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

// 3. إدارة المتاجر
exports.getAllStores = async (req, res) => {
    try {
        const stores = await Store.find()
            .select(STORE_LIST_SELECT)
            .populate("owner", "name email")
            .lean();
        res.status(200).json(stores.map(stripBase64StoreImages));
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.toggleStoreStatus = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: "المتجر غير موجود" });
        store.isActive = !store.isActive;
        await store.save();
        res.status(200).json({ message: "تم تغيير الحالة", isActive: store.isActive });
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};
exports.getAllUsers = async (req, res) => {
  try {
    const role = cleanString(req.query.role, { field: "role", max: 20 });
    if (role && !["customer", "store", "supplier", "admin"].includes(role)) {
      return res.status(400).json({ message: "role غير صالح" });
    }

    const filter = role ? { role } : {};

    const users = await User.find(filter).select(USER_SENSITIVE_SELECT);

    res.json(users.map(sanitizeUser));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// 4. إدارة التصنيفات
exports.getCategories = async (req, res) => {
    try {
        const categories = await Category.find();
        res.status(200).json(categories);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.addCategory = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "category");
        const name = cleanString(req.body.name, { field: "name", max: 80, required: true });
        const description = cleanString(req.body.description, { field: "description", max: 500 });
        const icon = cleanString(req.body.icon, { field: "icon", max: 80 });
        const type = cleanString(req.body.type || "store", { field: "type", max: 20 });
        if (!["store", "product"].includes(type)) {
            return res.status(400).json({ message: "type غير صالح" });
        }
        const payload = {
            name,
            description,
            icon,
            type,
            order: intInRange(req.body.order, { field: "order", min: 0, max: 10000 }) ?? 0,
            isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
        };
        if (req.body.parent) payload.parent = requireObjectId(req.body.parent, "parent");
        const category = await Category.create(payload);
        res.status(201).json(category);
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

// 5. إدارة الأكواد (Bulk Generation) - إصلاح الخطأ في السطر 33
exports.generateBulkCodes = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "code payload");
        const { count, rewardPoints, rewardEntries, storeId } = req.body;

        if (!storeId) {
            return res.status(400).json({ message: "يجب اختيار المتجر لإنشاء الأكواد" });
        }

        const safeStoreId = requireObjectId(storeId, "storeId");
        const safeCount = intInRange(count, { field: "count", min: 1, max: 500, required: true });
        const safeRewardPoints = intInRange(rewardPoints ?? 0, { field: "rewardPoints", min: 0, max: 1_000_000 });
        const safeRewardEntries = intInRange(rewardEntries ?? 0, { field: "rewardEntries", min: 0, max: 1_000_000 });

        const store = await Store.findById(safeStoreId);
        if (!store) return res.status(404).json({ message: "المتجر غير موجود" });
        if (!store.codePrefix) {
            return res.status(400).json({ message: "المتجر لا يملك بصمة أكواد — أعد تشغيل الخادم أو حدّث المتجر" });
        }

        const codes = [];

        for (let i = 0; i < safeCount; i++) {
            const code = generatePromoCodeString(store.codePrefix);

            const newCode = {
                code,
                rewardPoints: safeRewardPoints || 0,
                rewardEntries: safeRewardEntries || 0,
                store: safeStoreId,
                createdBy: req.user.id
            };

            codes.push(newCode);
        }

        const created = await PromoCode.insertMany(codes);

        res.status(201).json({
            message: `تم إنشاء ${safeCount} كود`,
            storePrefix: store.codePrefix,
            codes: created
        });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};
exports.getAllCodes = async (req, res) => {
  try {
    const codes = await PromoCode.find()
      .select(CODE_LIST_SELECT)
      .sort({ createdAt: -1 })
      .lean();
    res.json(codes);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
exports.checkCode = async (req, res) => {
  try {
    const safeCode = cleanString(req.params.code, { field: "code", max: 80, required: true });
    const code = await PromoCode.findOne({ code: safeCode });

    if (!code) {
      return res.json({ valid: false });
    }

    res.json({
      valid: true,
      used: code.currentUses > 0,
      usedBy: code.usedBy || null,
      data: code
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getCodes = async (req, res) => {
  const codes = await PromoCode.find()
    .select(CODE_LIST_SELECT)
    .sort({ createdAt: -1 })
    .lean();
  res.json(codes);
};
// 6. إدارة السحوبات
exports.getAllDraws = async (req, res) => {
    try {
        const draws = await DrawBatch.find().sort({ createdAt: -1 });
        res.status(200).json(draws);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.createDraw = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "draw");
        const eventDate = new Date(req.body.eventDate);
        if (Number.isNaN(eventDate.getTime())) {
            return res.status(400).json({ message: "eventDate غير صالح" });
        }
        const eventType = cleanString(req.body.eventType || "online", { field: "eventType", max: 30 });
        const requiredRank = cleanString(req.body.requiredRank || "all", { field: "requiredRank", max: 30 });
        if (!["field", "online", "fast_contest"].includes(eventType)) {
            return res.status(400).json({ message: "eventType غير صالح" });
        }
        if (!["bronze", "silver", "gold", "platinum", "all"].includes(requiredRank)) {
            return res.status(400).json({ message: "requiredRank غير صالح" });
        }
        const prizes = Array.isArray(req.body.prizes)
            ? req.body.prizes.slice(0, 20).map((p) => ({
                item: cleanString(p?.item || "جائزة", { field: "prize", max: 120 }),
                count: intInRange(p?.count ?? 1, { field: "prize.count", min: 1, max: 100 }),
            }))
            : [];
        const draw = await DrawBatch.create({
            name: cleanString(req.body.name, { field: "name", max: 120, required: true }),
            description: cleanString(req.body.description, { field: "description", max: 1000 }),
            eventType,
            targetAudience: cleanString(req.body.targetAudience || "الجميع", { field: "targetAudience", max: 120 }),
            prizes,
            eventDate,
            minParticipants: intInRange(req.body.minParticipants ?? 0, { field: "minParticipants", min: 0, max: 100000 }),
            requiredRank,
            displayOnHome: req.body.displayOnHome === undefined ? true : !!req.body.displayOnHome,
            displayDuration: numberInRange(req.body.displayDuration ?? 24, { field: "displayDuration", min: 1, max: 168 }),
        });
        res.status(201).json(draw);
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

exports.approveDraw = async (req, res) => {
    try {
        const drawId = requireObjectId(req.params.drawId, "drawId");
        const draw = await DrawBatch.findById(drawId);
        if (!draw) return res.status(404).json({ message: "الفعالية غير موجودة" });
        draw.status = "active";
        draw.adminApproval = { isApproved: true, approvedAt: new Date() };
        await draw.save();
        res.status(200).json(draw);
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

// اختيار الفائزين باختيار عشوائي مُرجَّح حسب عدد الفرص (entriesCount)
// كلما أنفق المستخدم فرصاً أكثر زاد وزنه في القرعة.
exports.drawWinners = async (req, res) => {
    try {
        const drawId = requireObjectId(req.params.drawId, "drawId");
        const draw = await DrawBatch.findById(drawId);
        if (!draw) return res.status(404).json({ message: "الفعالية غير موجودة" });
        if (!["active", "quorum_reached", "closed"].includes(draw.status)) {
            return res.status(400).json({ message: "لا يمكن سحب الفائزين في الحالة الحالية" });
        }
        if (!draw.participants.length) {
            return res.status(400).json({ message: "لا يوجد مشاركون في هذا السحب" });
        }

        // بناء قائمة الجوائز الفردية (حسب كمية كل جائزة)
        const prizeList = [];
        (draw.prizes || []).forEach(p => {
            for (let i = 0; i < (p.count || 1); i++) prizeList.push(p.item || "جائزة");
        });
        if (prizeList.length === 0) prizeList.push("جائزة");

        // مجمّع المشاركين مع أوزانهم (عدد الفرص)
        const pool = draw.participants.map(p => ({
            user: p.user,
            weight: p.entriesCount || 1
        }));

        const winners = [];
        const winnersCount = Math.min(prizeList.length, pool.length);
        for (let i = 0; i < winnersCount; i++) {
            const totalWeight = pool.reduce((s, e) => s + e.weight, 0);
            let r = Math.random() * totalWeight;
            let idx = 0;
            for (let j = 0; j < pool.length; j++) {
                r -= pool[j].weight;
                if (r <= 0) { idx = j; break; }
            }
            const chosen = pool.splice(idx, 1)[0]; // منع فوز نفس الشخص مرتين
            winners.push({ user: chosen.user, prize: prizeList[i] || "جائزة" });
        }

        draw.winners = winners;
        draw.status = "completed";
        await draw.save();

        await logActivity({
            action: "سحب الفائزين",
            details: `تم إعلان ${winners.length} فائزاً في سحب: ${draw.name}`,
            severity: "info"
        });

        const populated = await draw.populate("winners.user", "name email");
        res.status(200).json({
            message: "تم إعلان الفائزين بنجاح",
            winners: populated.winners,
            status: draw.status
        });
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

// 7. سجل النشاطات وتنبيهات الأمان
exports.getSecurityAlerts = async (req, res) => {
    try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const alerts = await ActivityLog.find({ severity: { $in: ["warning", "danger"] }, createdAt: { $gt: yesterday } }).sort({ createdAt: -1 }).limit(10);
        res.status(200).json({ hasAlerts: alerts.length > 0, alerts });
    } catch (error) { res.status(500).json({ message: "خطأ في جلب التنبيهات" }); }
};

exports.getActivityLogs = async (req, res) => {
    try {
        const logs = await ActivityLog.find().populate("user", "name role").sort({ createdAt: -1 }).limit(100);
        res.status(200).json(logs);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

// 8. إعدادات النظام
exports.updateSystemSettings = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "settings");
        const { key, value } = req.body;
        const safeKey = cleanString(key, { field: "key", max: 80, required: true });
        if (!/^[a-zA-Z0-9_.:-]+$/.test(safeKey)) {
            return res.status(400).json({ message: "key غير صالح" });
        }
        assertNoMongoOperators(value, "value");
        const old = await SystemSetting.findOne({ key: safeKey }).lean();
        const setting = await SystemSetting.findOneAndUpdate({ key: safeKey }, { value }, { upsert: true, new: true });
        platformSettings.clearCache();

        req.auditContext = {
            action: "تعديل إعدادات المنصة",
            details: `تعديل الإعداد: ${safeKey}`,
            operationType: "update",
            entityType: "settings",
            entityId: safeKey,
            entityName: safeKey,
            page: "Platform Settings",
            oldValues: old?.value ?? null,
            newValues: value,
            severity: "warning",
        };

        res.status(200).json(setting);
    } catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};

exports.getSystemSettings = async (req, res) => {
    try {
        const settings = await SystemSetting.find();
        res.status(200).json(settings);
    } catch (error) { res.status(500).json({ message: error.message }); }
};
exports.updateEnergy = async (req, res) => {
  const amount = intInRange(req.body.amount, { field: "amount", min: -1_000_000, max: 1_000_000, required: true });

  const userId = requireObjectId(req.params.id, "id");
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  user.energy += amount;

  await user.save();

  res.json(sanitizeUser(user));
};
exports.banUser = async (req, res) => {
  const userId = requireObjectId(req.params.id, "id");
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  const prevStatus = user.status;
  user.status = "banned";
  await tokenService.invalidateAllUserTokens(user);

  req.auditContext = {
    action: "حظر مستخدم",
    details: `حظر ${user.name || user.email}`,
    operationType: "disable",
    entityType: "user",
    entityId: user._id,
    entityName: user.name || user.email,
    page: "Users",
    oldValues: { status: prevStatus },
    newValues: { status: "banned" },
    severity: "warning",
  };

  res.json(sanitizeUser(user));
};
exports.deleteUser = async (req, res) => {
  const userId = requireObjectId(req.params.id, "id");
  const user = await User.findById(userId).lean();
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  await User.findByIdAndDelete(userId);

  req.auditContext = {
    action: "حذف مستخدم",
    details: `حذف ${user.name || user.email}`,
    operationType: "delete",
    entityType: "user",
    entityId: user._id,
    entityName: user.name || user.email,
    page: "Users",
    oldValues: { name: user.name, email: user.email, role: user.role },
    severity: "danger",
  };

  res.json({ message: "تم حذف المستخدم" });
};
exports.getUsersCount = async (req, res) => {
  const total = await User.countDocuments({ role: "customer" });

  res.json({ total });
};
exports.deleteCode = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");

    const code = await PromoCode.findById(id);

    if (!code) {
      return res.status(404).json({ message: "الكود غير موجود" });
    }

    await PromoCode.findByIdAndDelete(id);

    res.status(200).json({
      message: "تم حذف الكود بنجاح",
    });

  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message,
    });
  }
};
exports.deleteBulkCodes = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "ids");
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length > 500) {
      return res.status(400).json({
        message: "يرجى إرسال ids بشكل صحيح",
      });
    }
    const safeIds = ids.map((id) => requireObjectId(id, "id"));

    await PromoCode.deleteMany({
      _id: { $in: safeIds },
    });

    res.status(200).json({
      message: `تم حذف ${ids.length} كود بنجاح`,
    });

  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message,
    });
  }
};
