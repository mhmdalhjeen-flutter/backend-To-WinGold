const Region = require("../models/region");

function buildRegionTree(regions, parentId = null) {
  return regions
    .filter((r) => String(r.parent || null) === String(parentId || null))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name, "ar"))
    .map((r) => ({
      ...r,
      children: buildRegionTree(regions, r._id),
    }));
}

async function getAllRegionsActive() {
  return Region.find({ isActive: { $ne: false } }).sort({ sortOrder: 1, name: 1 }).lean();
}

async function getDescendantIds(regionId) {
  if (!regionId) return [];
  const all = await getAllRegionsActive();
  const ids = [String(regionId)];
  const walk = (parentId) => {
    all.filter((r) => String(r.parent) === String(parentId)).forEach((child) => {
      ids.push(String(child._id));
      walk(child._id);
    });
  };
  walk(regionId);
  return ids;
}

function getRegionPath(regionId, allRegions) {
  const path = [];
  let current = allRegions.find((r) => String(r._id) === String(regionId));
  while (current) {
    path.unshift(current.name);
    current = current.parent
      ? allRegions.find((r) => String(r._id) === String(current.parent))
      : null;
  }
  return path.join("، ");
}

module.exports = { buildRegionTree, getAllRegionsActive, getDescendantIds, getRegionPath };
