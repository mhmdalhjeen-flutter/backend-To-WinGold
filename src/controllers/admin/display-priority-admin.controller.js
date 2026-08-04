const Category = require("../../models/category");
const Store = require("../../models/store");
const Offer = require("../../models/offer");
const Product = require("../../models/product");
const { requireObjectId, assertNoMongoOperators } = require("../../utils/inputSecurity.util");
const {
  loadActiveStoreCategories,
  sortCategories,
} = require("../../utils/categoryHierarchy.util");
const storeDiscovery = require("../../services/storeDiscovery.service");
const {
  applyDisplayPrioritySort,
  applyOfferDisplayPrioritySort,
  applyProductDisplayPrioritySort,
  sortProductsByDefault,
} = require("../../utils/displayPriority.util");
const { sortOffersByRank } = require("../../utils/ranking.util");
const { getCategoryAndDescendantNames } = require("../category.controller");
const { expandCategoryIds } = require("../../utils/offerFeed.util");

async function applyCategoryIdFilter(query, categoryId) {
  if (!categoryId) return;
  const expandedIds = await expandCategoryIds([categoryId]);
  const names = await getCategoryAndDescendantNames(categoryId);
  const or = [];
  if (expandedIds.length) or.push({ categoryId: { $in: expandedIds } });
  if (names.length) or.push({ category: { $in: names } });
  if (!or.length) return;
  query.$and = query.$and || [];
  query.$and.push(or.length === 1 ? or[0] : { $or: or });
}

function sortCategorySiblings(categories, parentId = null) {
  const parentKey = parentId ? String(parentId) : null;
  return categories
    .filter((c) => {
      const catParent = c.parent ? String(c.parent) : null;
      return catParent === parentKey;
    })
    .sort(sortCategories);
}

async function bulkAssignDisplayPriority(Model, orderedIds, extraUpdate = {}) {
  const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
  const bulk = safeIds.map((id, index) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { displayPriority: index + 1, ...extraUpdate } },
    },
  }));
  await Model.bulkWrite(bulk);
}

exports.listMainCategories = async (_req, res) => {
  try {
    const categories = await loadActiveStoreCategories();
    const roots = sortCategorySiblings(categories, null).map((c) => ({
      _id: c._id,
      name: c.name,
      icon: c.icon || "",
      displayPriority: c.displayPriority ?? null,
      hasChildren: categories.some((child) => String(child.parent || "") === String(c._id)),
    }));
    res.json({ categories: roots });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listSecondLevels = async (req, res) => {
  try {
    const parentId = requireObjectId(req.query.parentId, "parentId");
    const categories = await loadActiveStoreCategories();
    const children = sortCategorySiblings(categories, parentId).map((c) => ({
      _id: c._id,
      name: c.name,
      icon: c.icon || "",
      displayPriority: c.displayPriority ?? null,
    }));
    res.json({ categories: children });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listStores = async (req, res) => {
  try {
    const categoryId = requireObjectId(req.query.categoryId, "categoryId");
    const query = { isActive: true };
    await applyCategoryIdFilter(query, categoryId);

    const stores = await Store.find(query)
      .select("name logo category categoryId displayPriority isActive")
      .lean();

    const sorted = applyDisplayPrioritySort(stores, (items) =>
      storeDiscovery.sortStoresList(items, {})
    );

    res.json({ stores: sorted });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listCatalog = async (req, res) => {
  try {
    const storeId = requireObjectId(req.params.storeId, "storeId");
    const store = await Store.findById(storeId).select("name logo").lean();
    if (!store) return res.status(404).json({ message: "المتجر غير موجود" });

    const [offers, products] = await Promise.all([
      Offer.find({ store: storeId, isActive: true })
        .select("title displayPriority featuredPriority priority createdAt image offerType")
        .lean(),
      Product.find({ store: storeId, isActive: true, isWholesale: false })
        .select("name displayPriority createdAt image price")
        .lean(),
    ]);

    const sortedOffers = applyOfferDisplayPrioritySort(offers, sortOffersByRank);
    const sortedProducts = applyProductDisplayPrioritySort(products, sortProductsByDefault);

    res.json({
      store: { _id: store._id, name: store.name, logo: store.logo || "" },
      offers: sortedOffers,
      products: sortedProducts,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reorderCategories = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds, parentId = null } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
      return res.status(400).json({ message: "orderedIds مطلوب" });
    }

    const parentKey = parentId ? String(requireObjectId(parentId, "parentId")) : null;
    const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
    const categories = await Category.find({ _id: { $in: safeIds } }).select("parent");

    if (categories.length !== safeIds.length) {
      return res.status(400).json({ message: "بعض التصنيفات غير موجودة" });
    }

    for (const cat of categories) {
      const catParent = cat.parent ? String(cat.parent) : null;
      if (catParent !== parentKey) {
        return res.status(400).json({ message: "التصنيفات لا تنتمي لنفس المستوى" });
      }
    }

    await bulkAssignDisplayPriority(Category, safeIds);
    res.json({ message: "تم حفظ ترتيب التصنيفات" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reorderStores = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
      return res.status(400).json({ message: "orderedIds مطلوب" });
    }

    await bulkAssignDisplayPriority(Store, orderedIds);
    res.json({ message: "تم حفظ ترتيب المتاجر" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reorderOffers = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds, storeId } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
      return res.status(400).json({ message: "orderedIds مطلوب" });
    }
    if (!storeId) return res.status(400).json({ message: "storeId مطلوب" });

    const safeStoreId = requireObjectId(storeId, "storeId");
    const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
    const count = await Offer.countDocuments({ _id: { $in: safeIds }, store: safeStoreId });
    if (count !== safeIds.length) {
      return res.status(400).json({ message: "بعض العروض لا تنتمي لهذا المتجر" });
    }

    const bulk = safeIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            displayPriority: index + 1,
            featuredPriority: index + 1,
          },
        },
      },
    }));
    await Offer.bulkWrite(bulk);

    res.json({ message: "تم حفظ ترتيب العروض" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reorderProducts = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "orderedIds");
    const { orderedIds, storeId } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
      return res.status(400).json({ message: "orderedIds مطلوب" });
    }
    if (!storeId) return res.status(400).json({ message: "storeId مطلوب" });

    const safeStoreId = requireObjectId(storeId, "storeId");
    const safeIds = orderedIds.map((id) => requireObjectId(id, "id"));
    const count = await Product.countDocuments({ _id: { $in: safeIds }, store: safeStoreId });
    if (count !== safeIds.length) {
      return res.status(400).json({ message: "بعض المنتجات لا تنتمي لهذا المتجر" });
    }

    await bulkAssignDisplayPriority(Product, safeIds);
    res.json({ message: "تم حفظ ترتيب المنتجات" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
