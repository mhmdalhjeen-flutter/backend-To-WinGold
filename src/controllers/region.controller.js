const Region = require("../models/region");
const { assertNoMongoOperators, cleanString, requireObjectId } = require("../utils/inputSecurity.util");

exports.getAll = async (req, res) => {
  try {
    const filter = req.query.all === "true" ? {} : { isActive: true };
    const regions = await Region.find(filter).sort({ sortOrder: 1, name: 1 }).lean();

    if (req.query.tree === "true") {
      const { buildRegionTree } = require("../utils/region.util");
      return res.json(buildRegionTree(regions));
    }

    res.json(regions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "region");
    const { name, parent, subRegions, isActive } = req.body;
    const safeName = cleanString(name, { field: "name", max: 120, required: true });

    const parentId = parent ? requireObjectId(parent, "parent") : null;
    const maxOrder = await Region.findOne({ parent: parentId }).sort({ sortOrder: -1 }).select("sortOrder");
    const sortOrder = (maxOrder?.sortOrder ?? -1) + 1;

    const region = await Region.create({
      name: safeName,
      parent: parentId,
      sortOrder,
      subRegions: Array.isArray(subRegions) ? subRegions : [],
      isActive: isActive !== undefined ? isActive : true,
    });
    res.status(201).json(region);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "اسم المنطقة مستخدم في نفس المستوى" });
    res.status(400).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "region");
    const id = requireObjectId(req.params.id, "id");
    const allowed = ["name", "parent", "isActive", "subRegions"];
    const patch = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    if (patch.name !== undefined) patch.name = cleanString(patch.name, { field: "name", max: 120, required: true });
    if (patch.parent !== undefined) patch.parent = patch.parent ? requireObjectId(patch.parent, "parent") : null;
    if (patch.subRegions !== undefined && !Array.isArray(patch.subRegions)) {
      return res.status(400).json({ message: "subRegions غير صالح" });
    }

    const region = await Region.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
    if (!region) return res.status(404).json({ message: "المنطقة غير موجودة" });
    res.json(region);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "اسم المنطقة مستخدم" });
    res.status(400).json({ message: err.message });
  }
};

/** إعادة ترتيب — { orderedIds: [id1, id2, ...] } ضمن نفس parent */
exports.reorder = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
      return res.status(400).json({ message: "orderedIds مطلوب" });
    }

    const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
    const bulk = safeIds.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } },
    }));
    await Region.bulkWrite(bulk);
    res.json({ message: "تم تحديث الترتيب" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const children = await Region.countDocuments({ parent: id });
    if (children > 0) {
      return res.status(400).json({ message: "احذف المناطق الفرعية أولاً" });
    }
    const region = await Region.findByIdAndDelete(id);
    if (!region) return res.status(404).json({ message: "المنطقة غير موجودة" });
    res.json({ message: "تم حذف المنطقة" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
