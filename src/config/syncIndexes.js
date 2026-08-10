const { safeLog } = require("../utils/logSanitize.util");

/** Models whose Priority 1 indexes must exist at runtime. */
const MODEL_PATHS = [
  "../models/codeOrder",
  "../models/store",
  "../models/user",
];

/**
 * Ensures schema-defined indexes exist in MongoDB.
 * Uses createIndexes (idempotent) — does not drop indexes missing from the schema.
 */
async function ensureSchemaIndexes() {
  for (const modelPath of MODEL_PATHS) {
    const Model = require(modelPath);
    try {
      await Model.createIndexes();
      safeLog("info", "mongodb_indexes_ensured", {
        model: Model.modelName,
        collection: Model.collection.name,
      });
    } catch (error) {
      safeLog("warn", "mongodb_indexes_ensure_failed", {
        model: Model.modelName,
        collection: Model.collection.name,
        message: error.message,
      });
    }
  }
}

module.exports = { ensureSchemaIndexes };
