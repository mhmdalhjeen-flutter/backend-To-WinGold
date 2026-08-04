const User = require("../models/user");
const CardType = require("../models/cardType");
const logActivity = require("../utils/logger");
const auditService = require("../services/audit.service");
const cache = require("../utils/responseCache.util");
const authSessionCache = require("../utils/authSessionCache.util");
const { USER_SENSITIVE_SELECT, sanitizeUser } = require("../utils/userSanitize.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { assertNoMongoOperators, cleanString, requireObjectId } = require("../utils/inputSecurity.util");

// تحديث الملف الشخصي (الأيقونة والاسم)
exports.updateProfile = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "profile");
        const { name, avatar } = req.body;
        const userId = req.user.id;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

        if (name) user.name = cleanString(name, { field: "name", max: 120 });
        if (avatar) user.avatar = await processOptionalImage(avatar, { maxWidth: 400, maxBytes: 800_000 });

        await user.save();
        cache.invalidate(`user:me:${userId}`);
        authSessionCache.invalidate(userId).catch(() => {});

        res.status(200).json({
            message: "تم تحديث الملف الشخصي بنجاح",
            user: {
                id: user._id,
                name: user.name,
                avatar: user.avatar,
                rank: user.rank
            }
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: "خطأ في تحديث البيانات", error: error.message });
    }
};

async function attachCardTypes(user) {
    const cards = user.inventory?.cards;
    if (!Array.isArray(cards) || cards.length === 0) return user;

    const typeIds = [...new Set(
        cards.map((c) => c.cardType?.toString?.() ?? String(c.cardType)).filter(Boolean)
    )];
    if (typeIds.length === 0) return user;

    const types = await CardType.find({ _id: { $in: typeIds } })
        .select("name pointsValue color image isActive")
        .lean();
    const typeMap = new Map(types.map((t) => [t._id.toString(), t]));

    for (const card of cards) {
        const id = card.cardType?.toString?.() ?? String(card.cardType);
        if (id && typeMap.has(id)) {
            card.cardType = typeMap.get(id);
        }
    }
    return user;
}

// جلب بيانات المستخدم الحالي
exports.getMe = async (req, res) => {
    try {
        let user = req._authUserDoc;
        if (!user) {
            user = await User.findById(req.user.id).select(USER_SENSITIVE_SELECT);
        }
        if (!user) {
            return res.status(404).json({ message: "المستخدم غير موجود" });
        }
        await attachCardTypes(user);
        res.status(200).json(sanitizeUser(user));
    } catch (error) {
        res.status(500).json({ message: "خطأ في جلب البيانات" });
    }
};

// --- تبديل البطاقة الملونة بنقاط XP ---
exports.redeemCard = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "redeemCard");
        const cardTypeId = requireObjectId(req.body.cardTypeId, "cardTypeId");
        const userId = req.user.id;

        const cardType = await CardType.findById(cardTypeId).select("name pointsValue isActive");
        if (!cardType || !cardType.isActive) {
            return res.status(400).json({ message: "نوع البطاقة غير صالح" });
        }

        const pointsToAdd = cardType.pointsValue || 0;
        const cardTypeOid = cardType._id;

        const updated = await User.findOneAndUpdate(
            {
                _id: userId,
                "inventory.cards": {
                    $elemMatch: { cardType: cardTypeOid, count: { $gte: 1 } },
                },
            },
            {
                $inc: {
                    points: pointsToAdd,
                    "inventory.cards.$[card].count": -1,
                },
            },
            {
                arrayFilters: [{ "card.cardType": cardTypeOid, "card.count": { $gte: 1 } }],
                new: true,
            }
        );

        if (!updated) {
            await auditService.logSensitiveOperation(req, {
                action: "محاولة تبديل بطاقة فاشلة",
                details: "لا يملك البطاقة أو العدد صفر",
                success: false,
                metadata: { cardTypeId: String(cardTypeId) },
            });
            return res.status(400).json({ message: "أنت لا تملك هذه البطاقة لتبديلها" });
        }

        const cardEntry = updated.inventory.cards.find(
            (c) => c.cardType.toString() === cardTypeOid.toString()
        );

        await logActivity({
            action: "تبديل بطاقة",
            details: `المستخدم ${updated.name} حول بطاقة ${cardType.name} إلى ${pointsToAdd} نقطة XP`,
            user: updated._id
        });

        await auditService.logSensitiveOperation(req, {
            action: "تبديل بطاقة",
            details: `تحويل ${cardType.name} إلى ${pointsToAdd} نقطة`,
            user: updated,
            metadata: { pointsAdded: pointsToAdd, cardTypeId: String(cardTypeId) },
        });

        cache.invalidate(`user:me:${userId}`);

        res.status(200).json({
            success: true,
            message: `تم تبديل البطاقة بنجاح! حصلت على ${pointsToAdd} نقطة`,
            newPoints: updated.points,
            remainingCount: cardEntry?.count ?? 0
        });

    } catch (error) {
        res.status(500).json({ message: "خطأ أثناء عملية التبديل", error: error.message });
    }
};
