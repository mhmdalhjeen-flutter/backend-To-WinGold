const Category = require("../models/category");
const { sortCategories } = require("../utils/categoryHierarchy.util");
const { assertNoMongoOperators, cleanString, intInRange, requireObjectId } = require("../utils/inputSecurity.util");

function parseOptionalDisplayPriority(value, field = "displayPriority") {
  if (value === null || value === "" || value === undefined) return null;
  return intInRange(value, { field, min: 1, max: 10000 });
}

// بناء شجرة متداخلة من قائمة مسطّحة.
const buildTree = (items, parent = null) => {
  return items
    .filter((c) => String(c.parent || null) === String(parent || null))
    .sort(sortCategories)
    .map((c) => ({
      _id: c._id,
      name: c.name,
      icon: c.icon,
      description: c.description,
      type: c.type,
      parent: c.parent || null,
      order: c.order,
      displayPriority: c.displayPriority ?? null,
      children: buildTree(items, c._id),
    }));
};

// أسماء تصنيف معيّن + كل أحفاده (تُستخدم لفلترة العروض حسب الأب).
const getCategoryAndDescendantNames = async (categoryId) => {
  const all = await Category.find().select("name parent").lean();
  const names = [];
  const collect = (id) => {
    const node = all.find((c) => String(c._id) === String(id));
    if (!node) return;
    names.push(node.name);
    all
      .filter((c) => String(c.parent || "") === String(id))
      .forEach((child) => collect(child._id));
  };
  collect(categoryId);
  return names;
};

/** أسماء تصنيفات تطابق نص البحث (مع أحفادها) — للفلترة في العروض */
const resolveCategoryNamesForSearch = async (q) => {
  if (!q || !String(q).trim()) return [];
  const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(safe, "i");
  const matched = await Category.find({ name: rx, isActive: { $ne: false } }).select("_id").lean();
  const names = new Set();
  for (const row of matched) {
    const list = await getCategoryAndDescendantNames(row._id);
    list.forEach((n) => names.add(n));
  }
  return [...names];
};

/* ============== عام ============== */

// قائمة مسطّحة (افتراضياً النشطة فقط).
exports.getAll = async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.all !== "true") filter.isActive = true;
    const categories = await Category.find(filter).lean();
    categories.sort(sortCategories);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// شجرة متداخلة (النشطة فقط).
exports.getTree = async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.type) filter.type = req.query.type;
    const categories = await Category.find(filter).lean();
    res.json(buildTree(categories, null));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ============== أدمن ============== */

exports.create = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "category");
    const { name, description, icon, parent, order, type, isActive, displayPriority } = req.body;
    const safeName = cleanString(name, { field: "name", max: 80, required: true });
    const safeType = cleanString(type || "store", { field: "type", max: 20 });
    if (!["store", "product"].includes(safeType)) return res.status(400).json({ message: "type غير صالح" });
    const category = await Category.create({
      name: safeName,
      description: cleanString(description, { field: "description", max: 500 }),
      icon: cleanString(icon, { field: "icon", max: 80 }),
      parent: parent ? requireObjectId(parent, "parent") : null,
      order: intInRange(order ?? 0, { field: "order", min: 0, max: 10000 }),
      displayPriority: parseOptionalDisplayPriority(displayPriority),
      type: safeType,
      isActive: isActive !== undefined ? isActive : true,
    });
    res.status(201).json(category);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "اسم التصنيف مستخدم بالفعل" });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "category");
    const id = requireObjectId(req.params.id, "id");
    // منع جعل التصنيف أباً لنفسه.
    if (req.body.parent && String(req.body.parent) === String(id)) {
      return res.status(400).json({ message: "لا يمكن أن يكون التصنيف أباً لنفسه" });
    }
    const patch = {};
    if (req.body.name !== undefined) patch.name = cleanString(req.body.name, { field: "name", max: 80, required: true });
    if (req.body.description !== undefined) patch.description = cleanString(req.body.description, { field: "description", max: 500 });
    if (req.body.icon !== undefined) patch.icon = cleanString(req.body.icon, { field: "icon", max: 80 });
    if (req.body.parent !== undefined) patch.parent = req.body.parent ? requireObjectId(req.body.parent, "parent") : null;
    if (req.body.order !== undefined) patch.order = intInRange(req.body.order, { field: "order", min: 0, max: 10000 });
    if (req.body.displayPriority !== undefined) {
      patch.displayPriority = parseOptionalDisplayPriority(req.body.displayPriority);
    }
    if (req.body.type !== undefined) {
      patch.type = cleanString(req.body.type, { field: "type", max: 20 });
      if (!["store", "product"].includes(patch.type)) return res.status(400).json({ message: "type غير صالح" });
    }
    if (req.body.isActive !== undefined) patch.isActive = !!req.body.isActive;
    const category = await Category.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });
    if (!category) return res.status(404).json({ message: "التصنيف غير موجود" });
    res.json(category);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "اسم التصنيف مستخدم بالفعل" });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف غير صحيح" });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const childCount = await Category.countDocuments({ parent: id });
    if (childCount > 0) {
      return res.status(400).json({
        message: "لا يمكن حذف تصنيف يحتوي على تصنيفات فرعية. احذف الفرعية أولاً.",
      });
    }
    const category = await Category.findByIdAndDelete(id);
    if (!category) return res.status(404).json({ message: "التصنيف غير موجود" });
    res.json({ message: "تم حذف التصنيف" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف غير صحيح" });
    }
    res.status(err.status || 500).json({ message: err.message });
  }
};

module.exports.getCategoryAndDescendantNames = getCategoryAndDescendantNames;
module.exports.resolveCategoryNamesForSearch = resolveCategoryNamesForSearch;
