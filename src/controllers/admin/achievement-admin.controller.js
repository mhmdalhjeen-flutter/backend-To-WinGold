const AchievementMilestone = require("../../models/achievementMilestone");
const { assertNoMongoOperators, cleanString, numberInRange, requireObjectId } = require("../../utils/inputSecurity.util");
const { processOptionalImage } = require("../../utils/imageProcess.util");

async function resyncSortOrders() {
  const milestones = await AchievementMilestone.find().sort({ pointsRequired: 1, createdAt: 1 });
  if (!milestones.length) return milestones;
  const bulk = milestones.map((m, index) => ({
    updateOne: { filter: { _id: m._id }, update: { $set: { sortOrder: index } } },
  }));
  await AchievementMilestone.bulkWrite(bulk);
  return milestones;
}
exports.list = async (_req, res) => {
  try {
    const milestones = await AchievementMilestone.find().sort({ sortOrder: 1, pointsRequired: 1 });
    res.json({ milestones });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "achievement");
    const { name, description, icon, image, pointsRequired, isActive } = req.body;
    const safeName = cleanString(name, { field: "name", max: 120, required: true });
    if (pointsRequired == null || Number(pointsRequired) < 0) {
      return res.status(400).json({ message: "عدد النقاط مطلوب" });
    }
    const milestone = await AchievementMilestone.create({
      name: safeName,
      description: cleanString(description, { field: "description", max: 1000 }),
      icon: cleanString(icon || "🏆", { field: "icon", max: 20 }),
      image: image ? await processOptionalImage(image, { maxWidth: 800, maxBytes: 800_000 }) : "",
      pointsRequired: numberInRange(pointsRequired, { field: "pointsRequired", min: 0, max: 1_000_000, required: true }),
      sortOrder: 0,
      isActive: isActive !== false,
    });
    await resyncSortOrders();
    const refreshed = await AchievementMilestone.findById(milestone._id);
    res.status(201).json({ milestone: refreshed });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "achievement");
    const id = requireObjectId(req.params.id, "id");
    const milestone = await AchievementMilestone.findById(id);
    if (!milestone) return res.status(404).json({ message: "غير موجود" });

    const fields = ["name", "description", "icon", "image", "pointsRequired", "isActive"];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) milestone[f] = req.body[f];
    });
    if (req.body.name !== undefined) milestone.name = cleanString(req.body.name, { field: "name", max: 120, required: true });
    if (req.body.description !== undefined) milestone.description = cleanString(req.body.description, { field: "description", max: 1000 });
    if (req.body.icon !== undefined) milestone.icon = cleanString(req.body.icon, { field: "icon", max: 20 });
    if (req.body.image !== undefined) {
      milestone.image = req.body.image ? await processOptionalImage(req.body.image, { maxWidth: 800, maxBytes: 800_000 }) : "";
    }
    if (req.body.pointsRequired != null) {
      milestone.pointsRequired = numberInRange(req.body.pointsRequired, { field: "pointsRequired", min: 0, max: 1_000_000 });
    }
    await milestone.save();
    await resyncSortOrders();
    const refreshed = await AchievementMilestone.findById(milestone._id);
    res.json({ milestone: refreshed });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    await AchievementMilestone.findByIdAndDelete(id);
    await resyncSortOrders();
    res.json({ message: "تم الحذف" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reorder = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ message: "orderedIds مطلوب" });
    const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
    const bulk = orderedIds.map((id, index) => ({
      updateOne: { filter: { _id: safeIds[index] }, update: { $set: { sortOrder: index } } },
    }));
    await AchievementMilestone.bulkWrite(bulk);
    res.json({ message: "تم الترتيب" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
