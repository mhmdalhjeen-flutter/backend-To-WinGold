/**
 * Verifies every QR image embedded in a sample activation-codes xlsx
 * decodes to the expected activation code (column B).
 */
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const jsQR = require("jsqr");
const { PNG } = require("pngjs");

async function main() {
  const samplePath = process.argv[2];
  if (!samplePath || !fs.existsSync(samplePath)) {
    console.error("Usage: node verify-activation-codes-qr.js <sample.xlsx>");
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(samplePath);
  const worksheet = workbook.worksheets[0];

  const expected = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    expected.push({
      row: rowNumber,
      code: String(row.getCell(2).value || "").trim(),
    });
  });

  const images = worksheet.getImages();
  if (images.length !== expected.length) {
    console.error(
      `FAIL: image count ${images.length} != code count ${expected.length}`
    );
    process.exit(1);
  }

  let pass = 0;
  const failures = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const media = workbook.model.media.find((m) => m.index === img.imageId);
    if (!media || !media.buffer) {
      failures.push({ row: expected[i].row, reason: "missing media buffer" });
      continue;
    }

    const png = PNG.sync.read(media.buffer);
    const decoded = jsQR(
      new Uint8ClampedArray(png.data),
      png.width,
      png.height
    );

    const expectedCode = expected[i].code;
    if (!decoded) {
      failures.push({ row: expected[i].row, reason: "QR not decodable", expectedCode });
      continue;
    }
    if (decoded.data !== expectedCode) {
      failures.push({
        row: expected[i].row,
        reason: `mismatch: got "${decoded.data}" expected "${expectedCode}"`,
      });
      continue;
    }

    pass += 1;
    console.log(
      `OK row ${expected[i].row}: ${expectedCode} (${png.width}x${png.height}px)`
    );
  }

  console.log(`\nRESULT: ${pass}/${expected.length} QR codes decoded successfully`);
  if (failures.length) {
    console.error("FAILURES:", JSON.stringify(failures, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
