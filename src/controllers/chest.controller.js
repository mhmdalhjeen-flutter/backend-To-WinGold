const DailyPrize = require("../models/dailyPrize");
const User = require("../models/user");
const logActivity = require("../utils/logger");

exports.openDailyChest = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: "المستخدم غير موجود" });
        }

        // التحقق من مرور 24 ساعة على آخر فتح للصندوق
        const now = new Date();
        if (user.lastChestOpened) {
            const lastOpened = new Date(user.lastChestOpened);
            const hoursSinceLast = (now - lastOpened) / (1000 * 60 * 60);

            if (hoursSinceLast < 24) {
                const remainingHours = Math.ceil(24 - hoursSinceLast);
                return res.status(400).json({ 
                    message: `لقد فتحت الصندوق بالفعل. يمكنك المحاولة مرة أخرى بعد ${remainingHours} ساعة.` 
                });
            }
        }

        // جلب الجوائز المتاحة
        const prizes = await DailyPrize.find({ isActive: true });
        if (prizes.length === 0) {
            return res.status(404).json({ message: "لا توجد جوائز متاحة حالياً. حاول لاحقاً." });
        }

        // اختيار جائزة عشوائية بناءً على الاحتمالية (بسيط حالياً)
        const randomIndex = Math.floor(Math.random() * prizes.length);
        const selectedPrize = prizes[randomIndex];

        // تحديث تاريخ آخر فتح للصندوق
        user.lastChestOpened = now;

        // تنفيذ أثر الجائزة (نقاط أو فرص دخول)
        if (selectedPrize.prizeType === "points") {
            user.points += selectedPrize.value;
        } else if (selectedPrize.prizeType === "entries") {
            user.entriesWallet += selectedPrize.value;
        }
        // أنواع الجوائز الأخرى (كود خصم، منتج) يتم التعامل معها في الواجهة أو سجل خاص

        await user.save();

        // تسجيل النشاط
        await logActivity({
            action: "فتح صندوق الكنز",
            details: `المستخدم ${user.name} كسب ${selectedPrize.title}`,
            user: user._id,
            ipAddress: req.ip
        });

        res.status(200).json({
            message: "مبروك! لقد فتحت صندوق الكنز",
            prize: selectedPrize
        });

    } catch (error) {
        res.status(500).json({ message: "خطأ في معالجة طلب الصندوق اليومي", error: error.message });
    }
};
