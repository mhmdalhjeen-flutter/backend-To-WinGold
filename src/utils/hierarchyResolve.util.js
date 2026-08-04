const Region = require("../models/region");
const Category = require("../models/category");

const loadRegionsByIds = async (ids) => {
  const unique = [...new Set(ids.map(String))];
  const rows = await Region.find({ _id: { $in: unique } }).lean();
  return Object.fromEntries(rows.map((r) => [String(r._id), r]));
};

const loadCategoriesByIds = async (ids) => {
  const unique = [...new Set(ids.map(String))];
  const rows = await Category.find({ _id: { $in: unique } }).lean();
  return Object.fromEntries(rows.map((c) => [String(c._id), c]));
};

/**
 * @param {string[]} pathIds — مسار معرفات من الجذر إلى الورقة
 */
async function resolveRegionPath(pathIds) {
  if (!pathIds?.length) return null;

  const ids = pathIds.map(String);
  const byId = await loadRegionsByIds(ids);

  const root = byId[ids[0]];
  if (!root) return null;

  const deepest = byId[ids[ids.length - 1]] || root;

  return {
    regionId: ids[0],
    subRegionId: ids.length > 1 ? ids[ids.length - 1] : null,
    region: root.name,
    subRegion: deepest.name,
  };
}

async function resolveCategoryPath(pathIds) {
  if (!pathIds?.length) return null;

  const ids = pathIds.map(String);
  const byId = await loadCategoriesByIds(ids);
  const leaf = byId[ids[ids.length - 1]];
  if (!leaf) return null;

  const names = ids.map((id) => byId[id]?.name).filter(Boolean);

  return {
    categoryId: ids[ids.length - 1],
    category: names.length > 1 ? names.join(" › ") : leaf.name,
  };
}

module.exports = { resolveRegionPath, resolveCategoryPath };
