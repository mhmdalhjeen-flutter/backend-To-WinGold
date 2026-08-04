const TreasureBox = require("../models/treasureBox");
const CardType = require("../models/cardType");
const User = require("../models/user");
const logActivity = require("../utils/logger");

exports.getAvailableBoxes = async (req, res) => {
    try {
        const boxes = await TreasureBox.find({ isActive: true })
            .populate('store', 'name logo')
            .populate('rewards.cardType', 'name color icon');
        res.status(200).json({ success: true, data: boxes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.openBox = async (req, res) => {
    try {
        const { boxId } = req.params;
        const userId = req.user.id;

        const box = await TreasureBox.findById(boxId).populate('rewards.cardType');
        if (!box || !box.isActive) {
            return res.status(404).json({ message: "هذا الصندوق غير متاح حالياً" });
        }

        const user = await User.findById(userId);

        // --- نظام المؤقت الذكي (24 ساعة للصندوق اليومي) ---
        if (box.boxType === "daily") {
            const now = new Date();
            if (user.lastChestOpened) {
                const lastOpened = new Date(user.lastChestOpened);
                const diffInHours = (now - lastOpened) / (1000 * 60 * 60);

                if (diffInHours < 24) {
                    const remainingHours = Math.ceil(24 - diffInHours);
                    return res.status(400).json({ 
                        message: `عذراً! هذا الصندوق يفتح مرة كل 24 ساعة. حاول مجدداً بعد ${remainingHours} ساعة.` 
                    });
                }
            }
            user.lastChestOpened = now; // تحديث وقت الفتح فقط للصناديق اليومية
        }

        // --- محرك الاحتمالات ---
        const rewards = box.rewards;
        if (!rewards || rewards.length === 0) {
            return res.status(404).json({ message: "هذا الصندوق فارغ حالياً" });
        }

        const totalProbability = rewards.reduce((sum, r) => sum + r.probability, 0);
        let random = Math.random() * totalProbability;
        
        let selectedReward = rewards[0];
        for (const reward of rewards) {
            if (random < reward.probability) {
                selectedReward = reward;
                break;
            }
            random -= reward.probability;
        }

        const wonCard = selectedReward.cardType;

        // تحديث المخزن
        const cardIndex = user.inventory.cards.findIndex(
            c => c.cardType.toString() === wonCard._id.toString()
        );

        if (cardIndex > -1) {
            user.inventory.cards[cardIndex].count += 1;
        } else {
            user.inventory.cards.push({ cardType: wonCard._id, count: 1 });
        }

        await user.save();

        await logActivity({
            action: "فتح صندوق كنز",
            details: `فاز ببطاقة ${wonCard.name} من صندوق ${box.title}`,
            user: userId
        });

        res.status(200).json({
            success: true,
            message: `مبروك! حصلت على بطاقة ${wonCard.name}`,
            wonCard: {
                name: wonCard.name,
                color: wonCard.color,
                icon: wonCard.icon,
                points: wonCard.pointsValue
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
