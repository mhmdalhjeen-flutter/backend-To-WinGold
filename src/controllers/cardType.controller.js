// controllers/cardType.controller.js
const CardType = require("../models/cardType");
const { assertNoMongoOperators, cleanString, numberInRange, requireObjectId } = require("../utils/inputSecurity.util");

// أدمن: إضافة نوع كرت جديد
exports.createCardType = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "cardType");
        const { name, price, points, color } = req.body;
        if (!name || !price || !points)
            return res.status(400).json({ message: "اسم وسعر ونقاط الكرت مطلوبة" });

        const card = await CardType.create({
            name: cleanString(name, { field: "name", max: 80, required: true }),
            price: numberInRange(price, { field: "price", min: 0, max: 10_000_000, required: true }),
            pointsValue: numberInRange(points, { field: "points", min: 0, max: 1_000_000, required: true }),
            color: cleanString(color || "#FFD700", { field: "color", max: 20 }),
            createdBy: req.user.id,
        });
        res.status(201).json({ message: "تم إضافة نوع الكرت", card });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// جلب كل أنواع الكروت (للأدمن وصاحب المتجر)
exports.getCardTypes = async (req, res) => {
    try {
        const cards = await CardType.find({ isActive: true }).sort({ createdAt: -1 });
        res.json({ cards });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// أدمن: تعديل نوع كرت
exports.updateCardType = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "cardType");
        const id = requireObjectId(req.params.id, "id");
        const patch = {};
        if (req.body.name !== undefined) patch.name = cleanString(req.body.name, { field: "name", max: 80, required: true });
        if (req.body.price !== undefined) patch.price = numberInRange(req.body.price, { field: "price", min: 0, max: 10_000_000 });
        if (req.body.points !== undefined) patch.pointsValue = numberInRange(req.body.points, { field: "points", min: 0, max: 1_000_000 });
        if (req.body.pointsValue !== undefined) patch.pointsValue = numberInRange(req.body.pointsValue, { field: "pointsValue", min: 0, max: 1_000_000 });
        if (req.body.color !== undefined) patch.color = cleanString(req.body.color, { field: "color", max: 20 });
        if (req.body.icon !== undefined) patch.icon = cleanString(req.body.icon, { field: "icon", max: 80 });
        if (req.body.description !== undefined) patch.description = cleanString(req.body.description, { field: "description", max: 500 });
        if (req.body.isActive !== undefined) patch.isActive = !!req.body.isActive;
        const card = await CardType.findByIdAndUpdate(id, patch, { new: true });
        if (!card) return res.status(404).json({ message: "النوع غير موجود" });
        res.json({ message: "تم التحديث", card });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// أدمن: حذف نوع كرت
exports.deleteCardType = async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const card = await CardType.findById(id);
        if (!card) return res.status(404).json({ message: "النوع غير موجود" });
        card.isActive = false;
        await card.save();
        res.json({ message: "تم الحذف" });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};