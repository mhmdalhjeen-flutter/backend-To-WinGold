const mongoose = require("mongoose");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMongoOperator(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return false;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return entries.some(([key, nested]) => (
    key.startsWith("$") ||
    key.includes(".") ||
    hasMongoOperator(nested)
  ));
}

function assertNoMongoOperators(value, field = "input") {
  if (hasMongoOperator(value)) {
    const err = new Error(`${field} غير صالح`);
    err.status = 400;
    throw err;
  }
}

function cleanString(value, { field = "input", max = 120, min = 0, required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw Object.assign(new Error(`${field} مطلوب`), { status: 400 });
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  const cleaned = String(value).trim();
  if (required && cleaned.length < Math.max(min, 1)) {
    throw Object.assign(new Error(`${field} مطلوب`), { status: 400 });
  }
  if (cleaned.length < min) {
    throw Object.assign(new Error(`${field} قصير جداً`), { status: 400 });
  }
  if (cleaned.length > max) {
    throw Object.assign(new Error(`${field} طويل جداً`), { status: 400 });
  }
  return cleaned;
}

function isValidObjectId(value) {
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value);
}

function requireObjectId(value, field = "id") {
  const cleaned = cleanString(value, { field, max: 40, required: true });
  if (!isValidObjectId(cleaned)) {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  return cleaned;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRegex(value, opts = {}) {
  const cleaned = cleanString(value, opts);
  return cleaned ? new RegExp(escapeRegex(cleaned), "i") : null;
}

function intInRange(value, { field = "input", min = 0, max = 1000, required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw Object.assign(new Error(`${field} مطلوب`), { status: 400 });
    return undefined;
  }
  if (typeof value === "object") {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  return parsed;
}

function numberInRange(value, { field = "input", min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw Object.assign(new Error(`${field} مطلوب`), { status: 400 });
    return undefined;
  }
  if (typeof value === "object") {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${field} غير صالح`), { status: 400 });
  }
  return parsed;
}

module.exports = {
  assertNoMongoOperators,
  cleanString,
  escapeRegex,
  hasMongoOperator,
  intInRange,
  isValidObjectId,
  numberInRange,
  requireObjectId,
  safeRegex,
};
