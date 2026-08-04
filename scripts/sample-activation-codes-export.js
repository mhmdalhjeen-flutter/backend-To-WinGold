/**
 * One-off sample exporter mirroring exportOrderCodes layout/QR presentation.
 * Does not touch APIs or code generation — presentation only.
 */
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");

const QR_DISPLAY_PX = 110;
const QR_RENDER_PX = 440;
const QR_ROW_HEIGHT = 96;
const QR_COL_WIDTH = 16;

function excelColWidthForText(text, min = 12, max = 45) {
  const len = String(text || "").length;
  const approx = Math.ceil(len * 1.15) + 3;
  return Math.min(Math.max(approx, min), max);
}

async function main() {
  const samples = [
    { store: "متجر الذهب الذهبي", code: "ACT-SAMPLE-001" },
    { store: "متجر النور", code: "ACT-SAMPLE-002" },
    { store: "Offers Tech Store", code: "WG-PRINT-TEST-003" },
    { store: "سوق العروض", code: "QR-VERIFY-004" },
  ];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("الأكواد", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });

  worksheet.columns = [
    { header: "اسم المتجر", key: "store", width: 20 },
    { header: "الرمز", key: "code", width: 20 },
    { header: "رمز QR", key: "qr", width: QR_COL_WIDTH },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, size: 12, color: { argb: "FF1F2937" } };
  headerRow.alignment = {
    horizontal: "center",
    vertical: "middle",
    readingOrder: "rtl",
    wrapText: true,
  };
  headerRow.height = 28;
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8EEF4" },
  };
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: "thin", color: { argb: "FFCBD5E1" } },
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
      left: { style: "thin", color: { argb: "FFCBD5E1" } },
      right: { style: "thin", color: { argb: "FFCBD5E1" } },
    };
  });

  let maxStoreWidth = excelColWidthForText("اسم المتجر");
  let maxCodeWidth = excelColWidthForText("الرمز");

  const cellWidthPx = QR_COL_WIDTH * 7;
  const cellHeightPx = QR_ROW_HEIGHT * (96 / 72);
  const colInset = Math.max(0, (cellWidthPx - QR_DISPLAY_PX) / 2) / cellWidthPx;
  const rowInset = Math.max(0, (cellHeightPx - QR_DISPLAY_PX) / 2) / cellHeightPx;

  for (let i = 0; i < samples.length; i++) {
    const { store, code } = samples[i];
    const rowIndex = i + 2;

    worksheet.addRow({ store, code });

    const row = worksheet.getRow(rowIndex);
    row.height = QR_ROW_HEIGHT;
    row.getCell(1).alignment = {
      vertical: "middle",
      horizontal: "right",
      readingOrder: "rtl",
      wrapText: true,
    };
    row.getCell(2).alignment = {
      vertical: "middle",
      horizontal: "center",
      readingOrder: "ltr",
    };
    row.getCell(3).alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    maxStoreWidth = Math.max(maxStoreWidth, excelColWidthForText(store));
    maxCodeWidth = Math.max(maxCodeWidth, excelColWidthForText(code, 14, 36));

    const qrDataUrl = await QRCode.toDataURL(code, {
      errorCorrectionLevel: "H",
      type: "image/png",
      width: QR_RENDER_PX,
      margin: 4,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const imageId = workbook.addImage({ base64, extension: "png" });

    worksheet.addImage(imageId, {
      tl: {
        col: 2 + colInset,
        row: rowIndex - 1 + rowInset,
      },
      ext: {
        width: QR_DISPLAY_PX,
        height: QR_DISPLAY_PX,
      },
      editAs: "oneCell",
    });
  }

  worksheet.getColumn(1).width = maxStoreWidth;
  worksheet.getColumn(2).width = maxCodeWidth;
  worksheet.getColumn(3).width = QR_COL_WIDTH;

  const outDir = path.join(__dirname, "..", "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `activation-codes-sample-${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(outPath);
  console.log("SAMPLE_PATH=" + outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
