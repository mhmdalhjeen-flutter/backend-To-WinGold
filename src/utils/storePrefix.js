const crypto = require("crypto");
const Store = require("../models/store");
const { safeLog } = require("./logSanitize.util");

/** تحويل اسم المتجر إلى بادئة ASCII قصيرة (2–6 أحرف). */
function slugFromName(name = "") {
  const cleaned = String(name)
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, "");

  if (!cleaned) return "ST";

  const latin = cleaned.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (latin.length >= 2) return latin.slice(0, 6);

  const hash = crypto.createHash("md5").update(cleaned).digest("hex").toUpperCase();
  return hash.slice(0, 4);
}

/** بادئة فريدة — يُعاد المحاولة مع لاحقة رقمية عند التعارض. */
async function assignUniqueStorePrefix(storeName, excludeStoreId = null) {
  const base = slugFromName(storeName);

  for (let i = 0; i < 200; i++) {
    const suffix = i === 0 ? "" : String(i);
    const candidate = `${base.slice(0, Math.max(2, 6 - suffix.length))}${suffix}`.toUpperCase();
    const query = { codePrefix: candidate };
    if (excludeStoreId) query._id = { $ne: excludeStoreId };
    const exists = await Store.findOne(query).select("_id");
    if (!exists) return candidate;
  }

  return `${base.slice(0, 3)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`.slice(0, 8);
}

/** تعبئة البادئات للمتاجر القديمة التي لا تملك codePrefix. */
async function backfillStorePrefixes() {
  const stores = await Store.find({ $or: [{ codePrefix: null }, { codePrefix: "" }] });
  for (const store of stores) {
    store.codePrefix = await assignUniqueStorePrefix(store.name, store._id);
    await store.save();
  }
  if (stores.length) {
    safeLog("info", "store_prefix_backfill_completed", { count: stores.length });
  }
}

module.exports = {
  slugFromName,
  assignUniqueStorePrefix,
  backfillStorePrefixes,
};
