const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function buildAttachmentContentDisposition(filename) {
  const fullName = String(filename || "export.xlsx").trim() || "export.xlsx";
  const asciiFallback = fullName
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim() || "export.xlsx";
  const encoded = encodeURIComponent(fullName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function normalizeExcelBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Invalid Excel buffer payload");
}

/**
 * Sends an .xlsx download with production-safe headers (ASCII fallback + UTF-8 filename).
 * Skips response compression for binary integrity.
 */
function sendExcelDownload(res, buffer, filename) {
  const xlsxBuffer = normalizeExcelBuffer(buffer);
  const fullName = String(filename || "export.xlsx").trim() || "export.xlsx";
  res.setHeader("Content-Type", EXCEL_MIME);
  res.setHeader("Content-Disposition", buildAttachmentContentDisposition(fullName));
  res.setHeader("X-Download-Filename", encodeURIComponent(fullName));
  res.setHeader("Content-Length", String(xlsxBuffer.length));
  res.setHeader("Cache-Control", "no-store");
  res.set("X-No-Compression", "1");
  return res.end(xlsxBuffer);
}

function isExcelExportRequest(req) {
  const path = String(req.originalUrl || req.url || "");
  return /\/export(?:\/|$|-)/i.test(path)
    || path.includes("export-paper-codes")
    || path.includes("direct-export");
}

module.exports = {
  EXCEL_MIME,
  buildAttachmentContentDisposition,
  normalizeExcelBuffer,
  sendExcelDownload,
  isExcelExportRequest,
};
