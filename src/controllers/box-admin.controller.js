const CardType = require("../models/cardType");
const TreasureBox = require("../models/treasureBox");
const {
    assertNoMongoOperators,
    cleanString,
    numberInRange,
    requireObjectId,
} = require("../utils/inputSecurity.util");

// --- إدارة أنواع البطاقات ---
exports.createCardType = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "cardType");
        const card = await CardType.create({
            name: cleanString(req.body.name, { field: "name", max: 80, required: true }),
            color: cleanString(req.body.color || "#FFD700", { field: "color", max: 20 }),
            pointsValue: numberInRange(req.body.pointsValue ?? req.body.points ?? 0, { field: "pointsValue", min: 0, max: 1_000_000 }),
            price: numberInRange(req.body.price ?? 0, { field: "price", min: 0, max: 10_000_000 }),
            icon: cleanString(req.body.icon || "credit-card", { field: "icon", max: 80 }),
            description: cleanString(req.body.description, { field: "description", max: 500 }),
            isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
        });
        res.status(201).json({ success: true, data: card });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getCardTypes = async (req, res) => {
    try {
        const cards = await CardType.find({ isActive: true });
        res.status(200).json({ success: true, data: cards });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// --- إدارة الصناديق ---
exports.createTreasureBox = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "treasureBox");
        const boxType = cleanString(req.body.boxType || "daily", { field: "boxType", max: 20 });
        if (!["daily", "promotional", "sponsored"].includes(boxType)) {
            return res.status(400).json({ success: false, message: "boxType غير صالح" });
        }
        const rewards = Array.isArray(req.body.rewards)
            ? req.body.rewards.slice(0, 20).map((r) => ({
                cardType: requireObjectId(r?.cardType, "cardType"),
                probability: numberInRange(r?.probability ?? 10, { field: "probability", min: 0, max: 100 }),
            }))
            : [];
        const requirements = req.body.requirements || {};
        const box = await TreasureBox.create({
            title: cleanString(req.body.title, { field: "title", max: 120, required: true }),
            description: cleanString(req.body.description, { field: "description", max: 1000 }),
            boxType,
            store: req.body.store ? requireObjectId(req.body.store, "store") : null,
            requirements: {
                requireFollow: !!requirements.requireFollow,
                followLink: cleanString(requirements.followLink, { field: "followLink", max: 500 }),
                requireShare: !!requirements.requireShare,
                shareCount: numberInRange(requirements.shareCount ?? 0, { field: "shareCount", min: 0, max: 1000 }),
                adVideoUrl: cleanString(requirements.adVideoUrl, { field: "adVideoUrl", max: 500 }),
            },
            rewards,
            isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
            costInEnergy: numberInRange(req.body.costInEnergy ?? 0, { field: "costInEnergy", min: 0, max: 1_000_000 }),
        });
        res.status(201).json({ success: true, data: box });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getTreasureBoxes = async (req, res) => {
    try {
        const boxes = await TreasureBox.find().populate('store').populate('rewards.cardType');
        res.status(200).json({ success: true, data: boxes });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
