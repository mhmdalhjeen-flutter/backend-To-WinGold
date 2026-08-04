/**
 * Response envelope — Foundation Phase (v1 API contract).
 * Legacy /api routes keep their existing { message } shape until migrated.
 */

function buildSuccess(data = null, meta = null) {
  const body = { success: true, data, error: null };
  if (meta != null) body.meta = meta;
  return body;
}

function buildError(code, message, details = null) {
  const error = { code, message };
  if (details != null) error.details = details;
  return { success: false, data: null, error };
}

function sendSuccess(res, data = null, options = {}) {
  const { status = 200, meta = null } = options;
  return res.status(status).json(buildSuccess(data, meta));
}

function sendError(res, code, message, options = {}) {
  const { status = 400, details = null } = options;
  return res.status(status).json(buildError(code, message, details));
}

/** Map legacy controller errors to envelope (for gradual v1 migration). */
function sendLegacyError(res, status, message, code = "REQUEST_FAILED") {
  return sendError(res, code, message, { status });
}

module.exports = {
  buildSuccess,
  buildError,
  sendSuccess,
  sendError,
  sendLegacyError,
};
