const Store = require("../models/store");
const StoreItemCategory = require("../models/storeItemCategory");
const Product = require("../models/product");
const Offer = require("../models/offer");
const {
  assertNoMongoOperators,
  cleanString,
  requireObjectId,
} = require("../utils/inputSecurity.util");

async function getOwnerStore(ownerId) {
  const store = await Store.findOne({ owner: ownerId }).select("_id name");
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }
  return store;
}

exports.listMyItemCategories = async (req, res) => {
  try {
    const store = await getOwnerStore(req.user.id);
    const categories = await StoreItemCategory.find({ store: store._id })
      .sort({ order: 1, name: 1 })
      .lean();
    res.json({ categories });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.createItemCategory = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "category");
    const store = await getOwnerStore(req.user.id);
    const name = cleanString(req.body.name, { field: "name", max: 80, required: true });

    const existing = await StoreItemCategory.findOne({ store: store._id, name });
    if (existing) {
      return res.status(409).json({ message: "يوجد نوع بنفس الاسم مسبقاً" });
    }

    const count = await StoreItemCategory.countDocuments({ store: store._id });
    const category = await StoreItemCategory.create({
      store: store._id,
      name,
      isActive: req.body.isActive !== false,
      order: count,
    });

    res.status(201).json({ message: "تم إضافة النوع", category });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.updateItemCategory = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "category");
    const store = await getOwnerStore(req.user.id);
    const categoryId = requireObjectId(req.params.id, "id");

    const category = await StoreItemCategory.findOne({ _id: categoryId, store: store._id });
    if (!category) {
      return res.status(404).json({ message: "النوع غير موجود" });
    }

    if (req.body.name !== undefined) {
      const name = cleanString(req.body.name, { field: "name", max: 80, required: true });
      const duplicate = await StoreItemCategory.findOne({
        store: store._id,
        name,
        _id: { $ne: categoryId },
      });
      if (duplicate) {
        return res.status(409).json({ message: "يوجد نوع بنفس الاسم مسبقاً" });
      }
      category.name = name;
    }

    if (req.body.isActive !== undefined) {
      category.isActive = !!req.body.isActive;
    }

    await category.save();
    res.json({ message: "تم تحديث النوع", category });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.deleteItemCategory = async (req, res) => {
  try {
    const store = await getOwnerStore(req.user.id);
    const categoryId = requireObjectId(req.params.id, "id");

    const category = await StoreItemCategory.findOne({ _id: categoryId, store: store._id });
    if (!category) {
      return res.status(404).json({ message: "النوع غير موجود" });
    }

    await Promise.all([
      Product.updateMany({ storeItemCategory: categoryId }, { $unset: { storeItemCategory: 1 } }),
      Offer.updateMany({ storeItemCategory: categoryId }, { $unset: { storeItemCategory: 1 } }),
      StoreItemCategory.deleteOne({ _id: categoryId }),
    ]);

    res.json({ message: "تم حذف النوع", deleted: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
