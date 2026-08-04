/**
 * Sample gift-code Excel export (Store Name | Gift Code | QR Value).
 */
const path = require("path");
const fs = require("fs");
const { buildGiftCodesExcelBuffer } = require("../src/utils/giftCodeExcelExport.util");

async function main() {
  const samples = [
    { store: "متجر الذهب الذهبي", code: "WG-SAMPLE-001" },
    { store: "متجر الذهب الذهبي", code: "WG-SAMPLE-002" },
    { store: "Offers Tech Store", code: "WG-PRINT-TEST-003" },
  ];

  const storeName = samples[0].store;
  const codes = samples.map((s) => s.code);
  const buffer = await buildGiftCodesExcelBuffer({ codes, storeName });

  const outDir = path.join(__dirname, "..", "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `gift-codes-sample-${Date.now()}.xlsx`);
  fs.writeFileSync(outPath, buffer);
  console.log("SAMPLE_PATH=" + outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
