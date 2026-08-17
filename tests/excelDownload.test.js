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
const ExcelJS = require("exceljs");

test("buildAttachmentContentDisposition uses ASCII fallback and UTF-8 filename*", () => {
  const header = buildAttachmentContentDisposition("متجر إياد.xlsx");
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.match(header, /%D9%85%D8%AA%D8%AC%D8%B1/);
});

test("sendExcelDownload sets X-Download-Filename for cross-origin clients", () => {
  const { sendExcelDownload } = require("../src/utils/excelDownload.util");
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    set(name, value) {
      this.headers[name] = value;
    },
    end() {},
  };
  sendExcelDownload(res, Buffer.from("test"), "متجر إياد.xlsx");
  assert.equal(decodeURIComponent(res.headers["X-Download-Filename"]), "متجر إياد.xlsx");
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

test("buildGiftCodesExcelBuffer uses Card Studio 5-column header order", async () => {
  const buffer = await buildGiftCodesExcelBuffer({
    codes: [{
      code: "WG-TEST-001",
      cardSource: "independent",
      rewardPoints: 20,
    }],
    storeName: "متجر إياد",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header, [
    "Store Name",
    "Gift Code",
    "QR Value",
    "Points",
    "Card Source",
  ]);
  const data = sheet.getRow(2).values.slice(1);
  assert.equal(data[0], "متجر إياد");
  assert.equal(data[1], "WG-TEST-001");
  assert.match(String(data[2]), /\?gift=WG-TEST-001/);
  assert.equal(data[3], 20);
  assert.equal(data[4], "مستقل");
  assert.equal(sheet.columnCount, 5);
});

test("normalizeExportCodeRow maps cardSource and rewardPoints", () => {
  const { normalizeExportCodeRow } = require("../src/utils/giftCodeExcelExport.util");
  const row = normalizeExportCodeRow({
    code: "WG-001",
    cardSource: "independent",
    rewardPoints: 25,
  });
  assert.equal(row.code, "WG-001");
  assert.equal(row.points, 25);
  assert.equal(row.source, "independent");
});
