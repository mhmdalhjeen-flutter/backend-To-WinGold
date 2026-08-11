const ExcelJS = require("exceljs");
const { getCustomerAppUrl, buildGiftActivationUrl } = require("./giftActivationUrl.util");
const { sanitizeExportFilename } = require("./subscriptionMonth.util");
const { CARD_SOURCES } = require("../constants/storeSubscription.constants");

function excelColWidthForText(text, min = 12, max = 60) {
  const len = String(text || "").length;
  const approx = Math.ceil(len * 1.15) + 3;
  return Math.min(Math.max(approx, min), max);
}

function normalizeExportCodeRow(code) {
  if (typeof code === "string") {
    return { code, source: CARD_SOURCES.INDEPENDENT };
  }
  return {
    code: code?.code || "",
    source: code?.source === CARD_SOURCES.SUBSCRIPTION
      ? CARD_SOURCES.SUBSCRIPTION
      : CARD_SOURCES.INDEPENDENT,
  };
}

function formatCardSourceLabel(source) {
  return source === CARD_SOURCES.SUBSCRIPTION ? 'اشتراك' : 'مستقل';
}

function buildGiftCodesExportFilename(storeName) {
  const safeName = sanitizeExportFilename(storeName);
  return `${safeName}-gift-codes.xlsx`;
}

async function buildGiftCodesExcelBuffer({ codes, storeName }) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("No gift codes supplied for Excel export");
  }

  const normalizedCodes = codes.map(normalizeExportCodeRow).filter((row) => row.code);
  if (!normalizedCodes.length) {
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
    { header: "مصدر الكرت", key: "source", width: 16 },
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
  let maxSourceWidth = excelColWidthForText("Card Source");
  let maxQrWidth = excelColWidthForText("QR Value", 20, 80);

  for (const rowData of normalizedCodes) {
    const qrValue = buildGiftActivationUrl(websiteUrl, rowData.code);
    const sourceLabel = formatCardSourceLabel(rowData.source);
    const row = worksheet.addRow({
      store: storeName || "",
      code: rowData.code,
      source: sourceLabel,
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
      horizontal: "center",
      readingOrder: "ltr",
    };
    row.getCell(4).alignment = {
      vertical: "middle",
      horizontal: "left",
      readingOrder: "ltr",
      wrapText: false,
    };

    maxStoreWidth = Math.max(maxStoreWidth, excelColWidthForText(storeName));
    maxCodeWidth = Math.max(maxCodeWidth, excelColWidthForText(rowData.code, 14, 36));
    maxSourceWidth = Math.max(maxSourceWidth, excelColWidthForText(sourceLabel, 12, 24));
    maxQrWidth = Math.max(maxQrWidth, excelColWidthForText(qrValue, 20, 80));
  }

  worksheet.getColumn(1).width = maxStoreWidth;
  worksheet.getColumn(2).width = maxCodeWidth;
  worksheet.getColumn(3).width = maxSourceWidth;
  worksheet.getColumn(4).width = maxQrWidth;

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildGiftCodesExcelBuffer,
  buildGiftCodesExportFilename,
  formatCardSourceLabel,
  normalizeExportCodeRow,
};
