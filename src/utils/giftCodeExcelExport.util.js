const ExcelJS = require("exceljs");
const { getCustomerAppUrl, buildGiftActivationUrl } = require("./giftActivationUrl.util");

function excelColWidthForText(text, min = 12, max = 60) {
  const len = String(text || "").length;
  const approx = Math.ceil(len * 1.15) + 3;
  return Math.min(Math.max(approx, min), max);
}

async function buildGiftCodesExcelBuffer({ codes, storeName }) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("No gift codes supplied for Excel export");
  }

  const websiteUrl = getCustomerAppUrl();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Gift Codes", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });

  worksheet.columns = [
    { header: "Store Name", key: "store", width: 20 },
    { header: "Gift Code", key: "code", width: 20 },
    { header: "QR Value", key: "qrValue", width: 40 },
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

  let maxStoreWidth = excelColWidthForText("Store Name");
  let maxCodeWidth = excelColWidthForText("Gift Code");
  let maxQrWidth = excelColWidthForText("QR Value", 20, 80);

  for (const code of codes) {
    const qrValue = buildGiftActivationUrl(websiteUrl, code);
    const row = worksheet.addRow({
      store: storeName || "",
      code,
      qrValue,
    });

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
      horizontal: "left",
      readingOrder: "ltr",
      wrapText: false,
    };

    maxStoreWidth = Math.max(maxStoreWidth, excelColWidthForText(storeName));
    maxCodeWidth = Math.max(maxCodeWidth, excelColWidthForText(code, 14, 36));
    maxQrWidth = Math.max(maxQrWidth, excelColWidthForText(qrValue, 20, 80));
  }

  worksheet.getColumn(1).width = maxStoreWidth;
  worksheet.getColumn(2).width = maxCodeWidth;
  worksheet.getColumn(3).width = maxQrWidth;

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildGiftCodesExcelBuffer,
};
