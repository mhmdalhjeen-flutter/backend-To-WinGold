/**
 * Excel download helpers — run with: node tests/excelDownload.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAttachmentContentDisposition,
  normalizeExcelBuffer,
  isExcelExportRequest,
} = require("../src/utils/excelDownload.util");
const { buildGiftCodesExcelBuffer } = require("../src/utils/giftCodeExcelExport.util");

test("buildAttachmentContentDisposition uses ASCII fallback and UTF-8 filename*", () => {
  const header = buildAttachmentContentDisposition("متجر-الذهب-gift-codes.xlsx");
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.match(header, /%D9%85%D8%AA%D8%AC%D8%B1/);
});

test("normalizeExcelBuffer accepts Buffer", () => {
  const input = Buffer.from("abc");
  assert.equal(normalizeExcelBuffer(input), input);
});

test("isExcelExportRequest matches code order and subscription exports", () => {
  assert.equal(isExcelExportRequest({ originalUrl: "/api/code-orders/admin/export/abc" }), true);
  assert.equal(isExcelExportRequest({ originalUrl: "/api/admin/store-subscriptions/periods/x/export-paper-codes" }), true);
  assert.equal(isExcelExportRequest({ originalUrl: "/api/code-orders/admin/direct-export" }), true);
  assert.equal(isExcelExportRequest({ originalUrl: "/api/admin/stores" }), false);
});

test("buildGiftCodesExcelBuffer returns a non-empty Buffer", async () => {
  const buffer = await buildGiftCodesExcelBuffer({
    codes: [{ code: "WG-TEST-001", source: "independent" }],
    storeName: "Test Store",
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
});

test("buildGiftCodesExcelBuffer rejects empty code list with status 400", async () => {
  await assert.rejects(
    () => buildGiftCodesExcelBuffer({ codes: [], storeName: "Store" }),
    (err) => err.status === 400,
  );
});
