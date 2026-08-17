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
    return { code, source: CARD_SOURCES.INDEPENDENT, points: null };
  }
  const rawSource = code?.source ?? code?.cardSource;
  const rawPoints = code?.points ?? code?.rewardPoints;
  const pointsNum = rawPoints == null ? null : Number(rawPoints);
  return {
    code: code?.code || "",
    source: rawSource === CARD_SOURCES.SUBSCRIPTION
      ? CARD_SOURCES.SUBSCRIPTION
      : CARD_SOURCES.INDEPENDENT,
    points: pointsNum != null && !Number.isNaN(pointsNum) ? pointsNum : null,
  };
}

function formatCardSourceLabel(source) {
  return source === CARD_SOURCES.SUBSCRIPTION ? 'اشتراك' : 'مستقل';
}

function buildGiftCodesExportFilename(storeName) {
  const safeName = sanitizeExportFilename(storeName);
  return `${safeName}.xlsx`;
}

async function buildGiftCodesExcelBuffer({ codes, storeName }) {
  if (!Array.isArray(codes) || codes.length === 0) {
    const err = new Error("لا توجد أكواد للتصدير");
    err.status = 400;
    throw err;
  }

  const normalizedCodes = codes.map(normalizeExportCodeRow).filter((row) => row.code);
  if (!normalizedCodes.length) {
    const err = new Error("لا توجد أكواد صالحة للتصدير");
    err.status = 400;
    throw err;
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
    { header: "Points", key: "points", width: 14 },
    { header: "Card Source", key: "source", width: 16 },
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
  let maxPointsWidth = excelColWidthForText("Points", 12, 20);
  let maxSourceWidth = excelColWidthForText("Card Source");

  for (const rowData of normalizedCodes) {
    const qrValue = buildGiftActivationUrl(websiteUrl, rowData.code);
    const sourceLabel = formatCardSourceLabel(rowData.source);
    const row = worksheet.addRow({
      store: storeName || "",
      code: rowData.code,
      source: sourceLabel,
      qrValue,
      points: rowData.points,
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
    row.getCell(4).alignment = {
      vertical: "middle",
      horizontal: "center",
      readingOrder: "ltr",
    };
    row.getCell(5).alignment = {
      vertical: "middle",
      horizontal: "center",
      readingOrder: "ltr",
    };

    maxStoreWidth = Math.max(maxStoreWidth, excelColWidthForText(storeName));
    maxCodeWidth = Math.max(maxCodeWidth, excelColWidthForText(rowData.code, 14, 36));
    maxQrWidth = Math.max(maxQrWidth, excelColWidthForText(qrValue, 20, 80));
    maxPointsWidth = Math.max(
      maxPointsWidth,
      excelColWidthForText(rowData.points == null ? "" : String(rowData.points), 12, 20),
    );
    maxSourceWidth = Math.max(maxSourceWidth, excelColWidthForText(sourceLabel, 12, 24));
  }

  worksheet.getColumn(1).width = maxStoreWidth;
  worksheet.getColumn(2).width = maxCodeWidth;
  worksheet.getColumn(3).width = maxQrWidth;
  worksheet.getColumn(4).width = maxPointsWidth;
  worksheet.getColumn(5).width = maxSourceWidth;

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildGiftCodesExcelBuffer,
  buildGiftCodesExportFilename,
  formatCardSourceLabel,
  normalizeExportCodeRow,
};
