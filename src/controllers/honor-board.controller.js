const HonorBoard = require("../models/honorBoard");
const { assertNoMongoOperators, cleanString, intInRange, requireObjectId } = require("../utils/inputSecurity.util");
const { processOptionalImage } = require("../utils/imageProcess.util");

// جلب العناصر النشطة للوحة الشرف (عام)
exports.getActiveHonorItems = async (req, res) => {
  try {
    const now = new Date();
    const items = await HonorBoard.find({
      isActive: true,
      displayUntil: { $gt: now },
    })
      .populate("user", "name avatar rank")
      .sort({ isPrimary: -1, priority: -1, createdAt: -1 });

    res.status(200).json(items);
  } catch (error) {
    res.status(500).json({ message: "حدث خطأ أثناء جلب لوحة الشرف", error: error.message });
  }
};

// قائمة كاملة للأدمن
exports.getAllAdmin = async (req, res) => {
  try {
    const items = await HonorBoard.find()
      .populate("user", "name avatar rank email")
      .sort({ isPrimary: -1, priority: -1, createdAt: -1 });
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// إضافة فائز (أدمن)
exports.addToHonorBoard = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "honorBoard");
    const {
      userId,
      title,
      message,
      awardImage,
      winnerImage,
      prizeName,
      receivedAt,
      competitionLink,
      isPrimary,
      durationInHours,
      priority,
    } = req.body;

    const displayUntil = new Date();
    displayUntil.setHours(displayUntil.getHours() + intInRange(durationInHours || 168, { field: "durationInHours", min: 1, max: 720 }));

    const newItem = new HonorBoard({
      user: requireObjectId(userId, "userId"),
      title: cleanString(title, { field: "title", max: 120, required: true }),
      message: cleanString(message, { field: "message", max: 1000 }),
      awardImage: awardImage ? await processOptionalImage(awardImage, { maxWidth: 800, maxBytes: 800_000 }) : "",
      winnerImage: winnerImage ? await processOptionalImage(winnerImage, { maxWidth: 800, maxBytes: 800_000 }) : null,
      prizeName: cleanString(prizeName || title || "", { field: "prizeName", max: 120 }),
      receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
      competitionLink: competitionLink || null,
      isPrimary: !!isPrimary,
      displayUntil,
      priority: intInRange(priority || 0, { field: "priority", min: 0, max: 10000 }),
    });

    await newItem.save();
    await newItem.populate("user", "name avatar rank");
    res.status(201).json({ message: "تمت الإضافة للوحة الشرف بنجاح", item: newItem });
  } catch (error) {
    res.status(error.status || 500).json({ message: "فشل إضافة العنصر", error: error.message });
  }
};

// تحديث فائز (أدمن)
exports.updateHonorItem = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "honorBoard");
    const id = requireObjectId(req.params.id, "id");
    const item = await HonorBoard.findById(id);
    if (!item) return res.status(404).json({ message: "العنصر غير موجود" });

    const fields = [
      "title", "message", "awardImage", "winnerImage", "prizeName",
      "competitionLink", "isPrimary", "priority", "isActive",
    ];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) item[f] = req.body[f];
    });
    if (req.body.title !== undefined) item.title = cleanString(req.body.title, { field: "title", max: 120, required: true });
    if (req.body.message !== undefined) item.message = cleanString(req.body.message, { field: "message", max: 1000 });
    if (req.body.awardImage !== undefined) {
      item.awardImage = req.body.awardImage ? await processOptionalImage(req.body.awardImage, { maxWidth: 800, maxBytes: 800_000 }) : "";
    }
    if (req.body.winnerImage !== undefined) {
      item.winnerImage = req.body.winnerImage ? await processOptionalImage(req.body.winnerImage, { maxWidth: 800, maxBytes: 800_000 }) : null;
    }
    if (req.body.prizeName !== undefined) item.prizeName = cleanString(req.body.prizeName, { field: "prizeName", max: 120 });
    if (req.body.competitionLink !== undefined) item.competitionLink = cleanString(req.body.competitionLink, { field: "competitionLink", max: 500 });
    if (req.body.priority !== undefined) item.priority = intInRange(req.body.priority, { field: "priority", min: 0, max: 10000 });
    if (req.body.receivedAt) item.receivedAt = new Date(req.body.receivedAt);
    if (req.body.durationInHours) {
      const displayUntil = new Date();
      displayUntil.setHours(displayUntil.getHours() + intInRange(req.body.durationInHours, { field: "durationInHours", min: 1, max: 720 }));
      item.displayUntil = displayUntil;
    }

    await item.save();
    await item.populate("user", "name avatar rank");
    res.json({ message: "تم التحديث", item });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.toggleStatus = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const item = await HonorBoard.findById(id);
    if (!item) return res.status(404).json({ message: "العنصر غير موجود" });

    item.isActive = !item.isActive;
    await item.save();
    res.status(200).json({ message: "تم تحديث الحالة", isActive: item.isActive });
  } catch (error) {
    res.status(error.status || 500).json({ message: "خطأ في التحديث", error: error.message });
  }
};

exports.deleteHonorItem = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const item = await HonorBoard.findByIdAndDelete(id);
    if (!item) return res.status(404).json({ message: "العنصر غير موجود" });
    res.json({ message: "تم الحذف" });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};
