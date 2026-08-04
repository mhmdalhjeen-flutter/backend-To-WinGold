const Category = require("../models/category");
const { compareDisplayPriority } = require("./displayPriority.util");

function sortCategories(a, b) {
  const pri = compareDisplayPriority(a, b);
  if (pri !== 0) return pri;
  return (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), "ar");
}

function buildCategoryIndex(categories) {
  const byId = new Map();
  const byName = new Map();
  for (const c of categories) {
    byId.set(String(c._id), c);
    byName.set(c.name, String(c._id));
  }
  return { byId, byName };
}

function getChildren(categories, parentId) {
  return categories
    .filter((c) => String(c.parent || "") === String(parentId || ""))
    .sort(sortCategories);
}

function getRoots(categories) {
  return getChildren(categories, null);
}

function findRootId(categoryId, byId) {
  let node = byId.get(String(categoryId));
  while (node?.parent) {
    node = byId.get(String(node.parent));
  }
  return node ? String(node._id) : null;
}

function findDirectChildOfRoot(categoryId, rootId, byId) {
  let node = byId.get(String(categoryId));
  if (!node) return null;
  if (String(node._id) === String(rootId)) return String(rootId);

  let current = node;
  while (current) {
    if (String(current.parent) === String(rootId)) return String(current._id);
    if (!current.parent) break;
    current = byId.get(String(current.parent));
  }
  return String(node._id);
}

function sectionKey(section) {
  return section.isParentFallback
    ? `parent-fallback:${section.categoryId}`
    : String(section.categoryId);
}

function resolveStoreCategoryId(store, index) {
  if (store?.categoryId) return String(store.categoryId);

  const catStr = String(store?.category || "").trim();
  if (!catStr) return null;

  if (index.byName.has(catStr)) return index.byName.get(catStr);

  if (catStr.includes(" › ")) {
    const parts = catStr.split(" › ").map((p) => p.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (index.byName.has(parts[i])) return index.byName.get(parts[i]);
    }
  }

  return null;
}

function resolveStoreCategoryIdByName(store, sections, index) {
  const catStr = String(store?.category || "").trim();
  if (!catStr) return null;

  for (const section of sections) {
    if (section.isParentFallback) continue;
    if (catStr === section.categoryName) return String(section.categoryId);
    if (catStr.includes(" › ")) {
      const leaf = catStr.split(" › ").pop().trim();
      if (leaf === section.categoryName) return String(section.categoryId);
    }
  }

  return resolveStoreCategoryId(store, index);
}

function resolveStoreSectionKey(store, sections, index) {
  const storeCatId = resolveStoreCategoryIdByName(store, sections, index);
  if (!storeCatId) return null;

  const rootId = findRootId(storeCatId, index.byId);
  if (!rootId) return null;

  const rootSections = sections.filter((s) => String(s.rootCategoryId) === rootId);
  const hasChildren = rootSections.some((s) => s.isParentFallback);

  if (String(storeCatId) === rootId && hasChildren) {
    const fallback = rootSections.find((s) => s.isParentFallback);
    return fallback ? sectionKey(fallback) : null;
  }

  const displayId = findDirectChildOfRoot(storeCatId, rootId, index.byId);
  const childSection = rootSections.find(
    (s) => !s.isParentFallback && String(s.categoryId) === String(displayId)
  );
  if (childSection) return sectionKey(childSection);

  if (!hasChildren) {
    const rootSection = rootSections.find((s) => !s.isParentFallback);
    return rootSection ? sectionKey(rootSection) : null;
  }

  return null;
}

function buildDisplaySections(categories) {
  const roots = getRoots(categories);
  const sections = [];

  for (const root of roots) {
    const children = getChildren(categories, root._id);

    if (!children.length) {
      sections.push({
        categoryId: root._id,
        categoryName: root.name,
        categoryIcon: root.icon || "",
        displayPriority: root.displayPriority ?? null,
        parentCategoryId: null,
        parentCategoryName: null,
        rootCategoryId: root._id,
        isParentFallback: false,
      });
      continue;
    }

    for (const child of children) {
      sections.push({
        categoryId: child._id,
        categoryName: child.name,
        categoryIcon: child.icon || root.icon || "",
        displayPriority: child.displayPriority ?? null,
        parentCategoryId: root._id,
        parentCategoryName: root.name,
        rootCategoryId: root._id,
        isParentFallback: false,
      });
    }

    sections.push({
      categoryId: root._id,
      categoryName: root.name,
      categoryIcon: root.icon || "",
      displayPriority: root.displayPriority ?? null,
      parentCategoryId: root._id,
      parentCategoryName: root.name,
      rootCategoryId: root._id,
      isParentFallback: true,
    });
  }

  return sections;
}

async function loadActiveStoreCategories() {
  return Category.find({ type: "store", isActive: true })
    .select("_id name icon parent order displayPriority")
    .lean();
}

function groupItemsBySection(items, sections, index, getStore) {
  const grouped = new Map();
  for (const section of sections) {
    grouped.set(sectionKey(section), []);
  }

  for (const item of items) {
    const store = getStore(item);
    const key = resolveStoreSectionKey(store, sections, index);
    if (!key || !grouped.has(key)) continue;
    grouped.get(key).push(item);
  }

  return grouped;
}

function buildParentGroupsFromSections(sections, groupedStores, interest = {}) {
  const parentMap = new Map();

  for (const section of sections) {
    const stores = groupedStores.get(sectionKey(section)) || [];
    if (!stores.length) continue;

    const parentId = section.parentCategoryId
      ? String(section.parentCategoryId)
      : String(section.rootCategoryId);
    const parentName = section.parentCategoryName || section.categoryName;
    const parentIcon = section.isParentFallback
      ? section.categoryIcon
      : sections.find((s) => String(s.categoryId) === parentId)?.categoryIcon
        || section.categoryIcon;

    if (!parentMap.has(parentId)) {
      parentMap.set(parentId, {
        parentCategoryId: parentId,
        parentCategory: parentName,
        parentCategoryIcon: parentIcon || "",
        sections: [],
      });
    }

    parentMap.get(parentId).sections.push({
      categoryId: section.categoryId,
      category: section.categoryName,
      categoryIcon: section.categoryIcon || "",
      displayPriority: section.displayPriority ?? null,
      isParentFallback: section.isParentFallback,
      interestScore: interest[section.categoryName] || 0,
      stores,
    });
  }

  return [...parentMap.values()];
}

module.exports = {
  loadActiveStoreCategories,
  buildCategoryIndex,
  buildDisplaySections,
  resolveStoreSectionKey,
  sectionKey,
  groupItemsBySection,
  buildParentGroupsFromSections,
  sortCategories,
};
