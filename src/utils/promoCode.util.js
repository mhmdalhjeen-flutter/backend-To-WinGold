const crypto = require("crypto");

const LEGACY_PREFIX = "OT-";

function generatePromoCodeString(storePrefix) {
  const prefix = (storePrefix || "OT").toUpperCase();
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${suffix}`;
}

/** استخراج البادئة من الكود الكامل (قبل أول -). */
function extractCodePrefix(code = "") {
  const normalized = String(code).trim().toUpperCase();
  const dash = normalized.indexOf("-");
  if (dash <= 0) return null;
  return normalized.slice(0, dash);
}

function isLegacyPromoCode(code = "") {
  return String(code).trim().toUpperCase().startsWith(LEGACY_PREFIX);
}

module.exports = {
  LEGACY_PREFIX,
  generatePromoCodeString,
  extractCodePrefix,
  isLegacyPromoCode,
};
