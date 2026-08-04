const DrawBatch = require("../models/drawBatch");
const User = require("../models/user");
const logActivity = require("../utils/logger");

// ترتيب الرتب لمقارنة متطلبات السحب
const RANK_ORDER = { bronze: 0, silver: 1, gold: 2, platinum: 3 };

// ================= الحصول على السحوبات المتاحة =================
exports.getOpenDraws = async (req, res) => {
    try {
        const draws = await DrawBatch.find({
            status: { $in: ["open", "quorum_reached", "active"] }
        }).select(
            "name description eventType eventDate prizes minParticipants requiredRank status displayOnHome totalEntries participants"
        );

        res.status(200).json(draws);
    } catch (error) {
        res.status(500).json({ message: "خطأ في جلب السحوبات", error: error.message });
    }
};

// ================= المشاركة في سحب معيّن =================
// قواعد العمل: الأدمن هو المتحكم في السحوبات. لا يوجد نظام تصويت.
// يمكن للمستخدم إنفاق عدّة فرص (entries) لزيادة حظه؛ كل فرصة إضافية ترفع وزنه في القرعة.
exports.joinDraw = async (req, res) => {
    try {
        const { drawId } = req.body;
        let { entriesToSpend } = req.body;
        const userId = req.user.id;

        // عدد الفرص المراد إنفاقها (افتراضي 1، عدد صحيح موجب)
        entriesToSpend = parseInt(entriesToSpend, 10);
        if (isNaN(entriesToSpend) || entriesToSpend < 1) entriesToSpend = 1;

        const draw = await DrawBatch.findById(drawId);
        if (!draw || !["open", "quorum_reached", "active"].includes(draw.status)) {
            return res.status(400).json({ message: "هذا السحب غير متاح للمشاركة حالياً" });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

        // التحقق من الرتبة المطلوبة
        if (draw.requiredRank && draw.requiredRank !== "all") {
            const userRankLevel = RANK_ORDER[user.rank] ?? 0;
            const requiredLevel = RANK_ORDER[draw.requiredRank] ?? 0;
            if (userRankLevel < requiredLevel) {
                return res.status(403).json({
                    message: `هذا السحب يتطلب رتبة ${draw.requiredRank} على الأقل`
                });
            }
        }

        // التحقق من رصيد الفرص
        if (user.entriesWallet < entriesToSpend) {
            return res.status(400).json({ message: "رصيدك من الفرص غير كافٍ" });
        }

        // خصم الفرص من المحفظة
        user.entriesWallet -= entriesToSpend;
        await user.save();

        // إضافة الفرص: إن كان مشاركاً نزيد فرصه، وإلا نضيفه مشاركاً جديداً
        const existing = draw.participants.find(p => p.user.toString() === userId);
        if (existing) {
            existing.entriesCount += entriesToSpend;
        } else {
            draw.participants.push({ user: userId, entriesCount: entriesToSpend });
        }
        draw.totalEntries = (draw.totalEntries || 0) + entriesToSpend;

        // تحديث الحالة تلقائياً عند اكتمال النصاب (عدد المشاركين الفريدين)
        if (
            draw.status === "open" &&
            draw.minParticipants > 0 &&
            draw.participants.length >= draw.minParticipants
        ) {
            draw.status = "quorum_reached";
        }
        await draw.save();

        await logActivity({
            action: "انضمام لسحب",
            details: `المستخدم ${user.name} أنفق ${entriesToSpend} فرصة في سحب: ${draw.name}`,
            user: userId
        });

        const myEntries = existing ? existing.entriesCount : entriesToSpend;
        res.status(200).json({
            message: "تمت المشاركة في السحب بنجاح",
            remainingWallet: user.entriesWallet,
            myEntries,
            totalEntries: draw.totalEntries,
            currentParticipants: draw.participants.length,
            minParticipants: draw.minParticipants,
            status: draw.status
        });
    } catch (error) {
        res.status(500).json({ message: "خطأ أثناء المشاركة", error: error.message });
    }
};

// ================= عرض سحوبات المستخدم =================
exports.getMyDraws = async (req, res) => {
    try {
        const draws = await DrawBatch.find({
            "participants.user": req.user.id
        }).select("name eventDate status winners prizes requiredRank minParticipants totalEntries participants");

        res.status(200).json(draws);
    } catch (error) {
        res.status(500).json({ message: "خطأ في جلب سحوباتك", error: error.message });
    }
};
