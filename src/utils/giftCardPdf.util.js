/**
 * Premium printable gift-card PDF generator (A4 sheets, 300 DPI QR assets).
 * Arabic labels rendered via Sharp+SVG for correct RTL shaping.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const sharp = require("sharp");
const { buildGiftActivationUrl } = require("./giftActivationUrl.util");

const MM_TO_PT = 72 / 25.4;
const CARD_MM = 60;
const CARD_PT = CARD_MM * MM_TO_PT;
const GAP_MM = 5;
const GAP_PT = GAP_MM * MM_TO_PT;
const COLS = 3;
const ROWS = 4;
const CARDS_PER_PAGE = COLS * ROWS;

const GRID_W = COLS * CARD_PT + (COLS - 1) * GAP_PT;
const GRID_H = ROWS * CARD_PT + (ROWS - 1) * GAP_PT;
const A4_W = 595.28;
const A4_H = 841.89;
const GRID_X = (A4_W - GRID_W) / 2;
const GRID_Y = (A4_H - GRID_H) / 2;

const GOLD = "#9A7209";
const GOLD_DARK = "#7A5900";
const GOLD_LIGHT = "#C9A227";
const RED_SOFT = "#C62828";
const RED_BRAND = "#991B1B";
const TEXT_DARK = "#111827";
const TEXT_MUTED = "#4B5563";

const FONT_DIR = path.join(__dirname, "../../node_modules/@fontsource/cairo/files");
const FONT_CANDIDATES = {
  regular: [
    path.join(__dirname, "../../assets/fonts/Cairo-Regular.ttf"),
    path.join(FONT_DIR, "cairo-arabic-400-normal.woff"),
    path.join(FONT_DIR, "cairo-arabic-400-normal.woff2"),
  ],
  bold: [
    path.join(__dirname, "../../assets/fonts/Cairo-Bold.ttf"),
    path.join(FONT_DIR, "cairo-arabic-700-normal.woff"),
    path.join(FONT_DIR, "cairo-arabic-700-normal.woff2"),
  ],
};

const WIN_GOLD_LOGO_CANDIDATES = [
  path.join(__dirname, "../../assets/brand/win-gold-customer-logo.png"),
  path.join(__dirname, "../../../customerFrontend/src/assets/logo/win-goldenstore-logo.png"),
  path.join(__dirname, "../../../win_golden_flutter/assets/brand/win-goldenstore-logo.png"),
];

const QR_OPTIONS = {
  errorCorrectionLevel: "H",
  type: "png",
  margin: 2,
  color: { dark: "#000000", light: "#FFFFFF" },
};

const arabicTextCache = new Map();
let fontAssets = null;
let winGoldLogoCache;

function isValidFontBuffer(buf) {
  if (!buf || buf.length < 1024) return false;
  const head = buf.slice(0, 4).toString("ascii");
  if (head === "wOFF" || head === "wOF2") return true;
  if (buf.toString("utf8", 0, 15).includes("<!DOCTYPE")) return false;
  return buf[0] !== 0x3c;
}

function resolveFontPath(variant) {
  for (const candidate of FONT_CANDIDATES[variant]) {
    if (!fs.existsSync(candidate)) continue;
    const buf = fs.readFileSync(candidate);
    if (isValidFontBuffer(buf)) return candidate;
  }
  throw new Error(`Gift card font missing (${variant}). Run npm install in backend.`);
}

function loadFontAssets() {
  if (fontAssets) return fontAssets;

  const regularPath = resolveFontPath("regular");
  const boldPath = resolveFontPath("bold");

  fontAssets = {
    regularPath,
    boldPath,
    regularData: fs.readFileSync(regularPath),
    boldData: fs.readFileSync(boldPath),
  };
  return fontAssets;
}

function registerFonts(doc) {
  const fonts = loadFontAssets();
  doc.registerFont("Cairo", fonts.regularPath);
  doc.registerFont("CairoBold", fonts.boldPath);
  return fonts;
}

function fontFormatFromPath(fontPath) {
  if (fontPath.endsWith(".woff2")) return "woff2";
  if (fontPath.endsWith(".woff")) return "woff";
  return "truetype";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderArabicText({
  text,
  widthPt,
  fontSizePt,
  color = TEXT_DARK,
  bold = false,
  align = "center",
  maxLines = 1,
}) {
  const cacheKey = [text, widthPt, fontSizePt, color, bold, align, maxLines].join("|");
  if (arabicTextCache.has(cacheKey)) return arabicTextCache.get(cacheKey);

  const fonts = loadFontAssets();
  const fontPath = bold ? fonts.boldPath : fonts.regularPath;
  const fontData = bold ? fonts.boldData : fonts.regularData;
  const format = fontFormatFromPath(fontPath);

  const widthPx = Math.max(32, Math.round((widthPt / 72) * 300));
  const fontSizePx = Math.max(9, Math.round((fontSizePt / 72) * 300));
  const lineHeightPx = Math.round(fontSizePx * 1.28);
  const heightPx = lineHeightPx * maxLines + 6;

  const anchor = align === "right" ? "end" : align === "left" ? "start" : "middle";
  const x = align === "right" ? widthPx - 2 : align === "left" ? 2 : widthPx / 2;
  const lines = String(text).split("\n").slice(0, maxLines);
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? fontSizePx + 2 : lineHeightPx;
      return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${widthPx}" height="${heightPx}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style><![CDATA[
      @font-face {
        font-family: 'CairoPDF';
        src: url('data:font/${format};base64,${fontData.toString("base64")}') format('${format}');
      }
      .label {
        font-family: 'CairoPDF', sans-serif;
        font-size: ${fontSizePx}px;
        fill: ${color};
        direction: rtl;
        unicode-bidi: plaintext;
      }
    ]]></style>
  </defs>
  <text y="0" text-anchor="${anchor}" class="label">${tspans}</text>
</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const block = { png, widthPt, heightPt: (heightPx / 300) * 72 };
  arabicTextCache.set(cacheKey, block);
  return block;
}

function drawArabicBlock(doc, block, x, y, widthPt) {
  if (!block?.png) return y;
  doc.image(block.png, x, y, { width: widthPt, height: block.heightPt });
  return y + block.heightPt;
}

async function loadWinGoldLogoBuffer() {
  if (winGoldLogoCache !== undefined) return winGoldLogoCache;

  for (const candidate of WIN_GOLD_LOGO_CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    try {
      winGoldLogoCache = await sharp(candidate)
        .resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      return winGoldLogoCache;
    } catch {
      /* try next */
    }
  }

  winGoldLogoCache = null;
  return null;
}

async function loadStoreIconBuffer(storeLogo, storeName) {
  try {
    if (storeLogo && /^https?:\/\//i.test(storeLogo)) {
      const res = await fetch(storeLogo);
      if (!res.ok) throw new Error("store logo fetch failed");
      const buf = Buffer.from(await res.arrayBuffer());
      return sharp(buf).resize(80, 80, { fit: "cover" }).png().toBuffer();
    }

    if (storeLogo && storeLogo.startsWith("data:image")) {
      const base64 = storeLogo.split(",")[1];
      return sharp(Buffer.from(base64, "base64"))
        .resize(80, 80, { fit: "cover" })
        .png()
        .toBuffer();
    }

    if (storeLogo && fs.existsSync(storeLogo)) {
      return sharp(storeLogo).resize(80, 80, { fit: "cover" }).png().toBuffer();
    }
  } catch {
    /* fall through to placeholder */
  }

  const initial = encodeURIComponent(String(storeName || "S").trim().charAt(0) || "S");
  const avatarUrl = `https://ui-avatars.com/api/?name=${initial}&background=6366f1&color=fff&size=128&bold=true`;
  try {
    const res = await fetch(avatarUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return sharp(buf).resize(80, 80, { fit: "cover" }).png().toBuffer();
  } catch {
    return null;
  }
}

async function generateQrBuffer(text, px) {
  return QRCode.toBuffer(String(text), {
    ...QR_OPTIONS,
    width: px,
  });
}

function cardPosition(slotIndex) {
  const col = slotIndex % COLS;
  const row = Math.floor(slotIndex / COLS);
  return {
    x: GRID_X + col * (CARD_PT + GAP_PT),
    y: GRID_Y + row * (CARD_PT + GAP_PT),
  };
}

function drawRoundedCardFrame(doc, x, y) {
  const radius = 10;

  doc.save();
  doc.roundedRect(x, y, CARD_PT, CARD_PT, radius).clip();
  doc.rect(x, y, CARD_PT, CARD_PT).fill("#FFFFFF");
  doc.rect(x, y, CARD_PT, 4).fill(GOLD_DARK);
  doc.rect(x, y + CARD_PT - 2.5, CARD_PT, 2.5).fill(RED_SOFT);
  doc.opacity(0.06);
  doc.fillColor(GOLD);
  doc.font("CairoBold").fontSize(70);
  doc.text("WG", x, y + CARD_PT * 0.3, { width: CARD_PT, align: "center", lineBreak: false });
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.roundedRect(x, y, CARD_PT, CARD_PT, radius).lineWidth(0.9).strokeColor(GOLD).stroke();
  doc.restore();
}

function drawBrandHeader(doc, x, y, { storeIcon, winGoldLogo }) {
  const iconSize = 13;
  const logoSize = 20;
  const gap = 4;
  const labelW = 34;
  const totalW = iconSize + gap + logoSize + gap + labelW;
  const startX = x + (CARD_PT - totalW) / 2;
  const headerY = y + 4;

  if (storeIcon) {
    doc.save();
    doc.circle(startX + iconSize / 2, headerY + iconSize / 2, iconSize / 2).clip();
    doc.image(storeIcon, startX, headerY, { width: iconSize, height: iconSize });
    doc.restore();
  }

  const logoX = startX + iconSize + gap;
  if (winGoldLogo) {
    doc.image(winGoldLogo, logoX, headerY - 1, { width: logoSize, height: logoSize, fit: [logoSize, logoSize] });
  }

  doc.font("CairoBold").fontSize(7.5).fillColor(GOLD_DARK);
  doc.text("Win Gold", logoX + logoSize + gap, headerY + 4, {
    width: labelW,
    align: "left",
    lineBreak: false,
  });

  return y + 22;
}

async function drawCardFront(doc, x, y, { storeName, code, giftQr, storeIcon, winGoldLogo }) {
  drawRoundedCardFrame(doc, x, y);

  const pad = 6;
  const innerX = x + pad;
  const innerW = CARD_PT - pad * 2;
  let cursorY = drawBrandHeader(doc, x, y, { storeIcon, winGoldLogo });

  const giftLine = `هدية مقدمة من ${storeName || "—"}`;
  const giftFontSize = giftLine.length > 34 ? 5.4 : giftLine.length > 28 ? 5.8 : 6.2;

  cursorY = drawArabicBlock(
    doc,
    await renderArabicText({
      text: giftLine,
      widthPt: innerW,
      fontSizePt: giftFontSize,
      color: TEXT_DARK,
      bold: true,
      maxLines: 1,
    }),
    innerX,
    cursorY,
    innerW
  ) + 2;

  const qrSize = 56;
  doc.image(giftQr, x + (CARD_PT - qrSize) / 2, cursorY, { width: qrSize, height: qrSize });
  cursorY += qrSize + 2;

  doc.font("CairoBold").fontSize(5.2).fillColor(TEXT_MUTED);
  doc.text("CODE:", innerX, cursorY, { width: innerW, align: "center", lineBreak: false });
  cursorY += 6;

  doc.font("CairoBold").fontSize(9.2).fillColor(TEXT_DARK);
  doc.text(String(code || ""), innerX, cursorY, { width: innerW, align: "center", lineBreak: false });
  cursorY += 11;

  cursorY = drawArabicBlock(
    doc,
    await renderArabicText({
      text: "ابدأ رحلتك مع Win Gold وكن أول فائز",
      widthPt: innerW,
      fontSizePt: 5.2,
      color: GOLD_DARK,
      maxLines: 1,
    }),
    innerX,
    cursorY,
    innerW
  );

  const hintY = y + CARD_PT - 11;
  drawArabicBlock(
    doc,
    await renderArabicText({
      text: "امسح الرمز من داخل تطبيق Win Gold",
      widthPt: innerW,
      fontSizePt: 4.8,
      color: TEXT_MUTED,
      maxLines: 1,
    }),
    innerX,
    hintY,
    innerW
  );
}

async function drawBackTextPair(doc, x, y, w, title, desc, titleSize = 5.4, descSize = 4.6) {
  drawArabicBlock(
    doc,
    await renderArabicText({
      text: title,
      widthPt: w,
      fontSizePt: titleSize,
      bold: true,
      align: "right",
      maxLines: 1,
    }),
    x,
    y,
    w
  );
  drawArabicBlock(
    doc,
    await renderArabicText({
      text: desc,
      widthPt: w,
      fontSizePt: descSize,
      color: TEXT_MUTED,
      align: "right",
      maxLines: 1,
    }),
    x,
    y + 6,
    w
  );
}

async function drawCardBack(doc, x, y, { websiteQr }) {
  drawRoundedCardFrame(doc, x, y);

  const pad = 6;
  const innerX = x + pad;
  const innerW = CARD_PT - pad * 2;
  let cursorY = y + 5;

  cursorY = drawArabicBlock(
    doc,
    await renderArabicText({
      text: "ماذا يقدم Win Gold؟",
      widthPt: innerW,
      fontSizePt: 6,
      bold: true,
      maxLines: 1,
    }),
    innerX,
    cursorY,
    innerW
  ) + 2;

  const features = [
    ["العروض", "خصومات يومية"],
    ["النقاط", "اجمع واستبدل"],
    ["السوق العام", "بيع وشراء بسهولة"],
    ["المسابقات", "شارك واربح"],
  ];
  const colW = innerW / 2;

  for (let i = 0; i < features.length; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    await drawBackTextPair(
      doc,
      innerX + col * colW,
      cursorY + row * 13,
      colW - 2,
      features[i][0],
      features[i][1]
    );
  }
  cursorY += 29;

  cursorY = drawArabicBlock(
    doc,
    await renderArabicText({
      text: "طريقة الاستخدام",
      widthPt: innerW,
      fontSizePt: 5.8,
      bold: true,
      maxLines: 1,
    }),
    innerX,
    cursorY,
    innerW
  ) + 2;

  const steps = [
    "① افتح تطبيق أو موقع Win Gold",
    "② اضغط على \"إدخال الكود\"",
    "③ امسح رمز البطاقة أو أدخل الكود يدوياً",
  ];

  for (const step of steps) {
    cursorY = drawArabicBlock(
      doc,
      await renderArabicText({
        text: step,
        widthPt: innerW,
        fontSizePt: 5,
        align: "right",
        maxLines: 1,
      }),
      innerX,
      cursorY,
      innerW
    ) + 1;
  }

  cursorY += 1;
  doc.save();
  doc.roundedRect(innerX, cursorY, innerW, 12, 3).fill("#FEE2E2");
  doc.restore();

  cursorY = drawArabicBlock(
    doc,
    await renderArabicText({
      text: "هذه البطاقة هدية مجانية\nغير قابلة للبيع أو الشراء",
      widthPt: innerW,
      fontSizePt: 4.8,
      color: RED_BRAND,
      bold: true,
      maxLines: 2,
    }),
    innerX,
    cursorY + 1,
    innerW
  ) + 2;

  const qrSize = 24;
  doc.image(websiteQr, x + (CARD_PT - qrSize) / 2, cursorY, { width: qrSize, height: qrSize });
  cursorY += qrSize + 1;

  drawArabicBlock(
    doc,
    await renderArabicText({
      text: "زور Win Gold",
      widthPt: innerW,
      fontSizePt: 4.6,
      color: TEXT_MUTED,
      maxLines: 1,
    }),
    innerX,
    cursorY,
    innerW
  );
}

function drawCropMarks(doc, x, y) {
  const mark = 6;
  const off = 3;
  doc.save();
  doc.lineWidth(0.35).strokeColor("#CBD5E1");

  doc.moveTo(x - off - mark, y).lineTo(x - off, y).stroke();
  doc.moveTo(x, y - off - mark).lineTo(x, y - off).stroke();
  doc.moveTo(x + CARD_PT + off, y).lineTo(x + CARD_PT + off + mark, y).stroke();
  doc.moveTo(x + CARD_PT, y - off - mark).lineTo(x + CARD_PT, y - off).stroke();
  doc.moveTo(x - off - mark, y + CARD_PT).lineTo(x - off, y + CARD_PT).stroke();
  doc.moveTo(x, y + CARD_PT + off).lineTo(x, y + CARD_PT + off + mark).stroke();
  doc.moveTo(x + CARD_PT + off, y + CARD_PT).lineTo(x + CARD_PT + off + mark, y + CARD_PT).stroke();
  doc.moveTo(x + CARD_PT, y + CARD_PT + off).lineTo(x + CARD_PT, y + CARD_PT + off + mark).stroke();

  doc.restore();
}

async function generateGiftCardPdf({ codes, storeName, storeLogo, websiteUrl }) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("No gift codes supplied for PDF export");
  }

  const [winGoldLogo, storeIcon, websiteQr] = await Promise.all([
    loadWinGoldLogoBuffer(),
    loadStoreIconBuffer(storeLogo, storeName),
    generateQrBuffer(websiteUrl, 420),
  ]);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
      info: {
        Title: "Win Gold Gift Cards",
        Author: "Win Gold",
        Subject: "Print-ready gift cards",
      },
    });

    try {
      registerFonts(doc);
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    (async () => {
      try {
        for (let pageStart = 0; pageStart < codes.length; pageStart += CARDS_PER_PAGE) {
          doc.addPage();
          const batch = codes.slice(pageStart, pageStart + CARDS_PER_PAGE);

          for (let slot = 0; slot < batch.length; slot += 1) {
            const pos = cardPosition(slot);
            const giftQr = await generateQrBuffer(
              buildGiftActivationUrl(websiteUrl, batch[slot]),
              640
            );
            await drawCardFront(doc, pos.x, pos.y, {
              storeName,
              code: batch[slot],
              giftQr,
              storeIcon,
              winGoldLogo,
            });
            drawCropMarks(doc, pos.x, pos.y);
          }
        }

        for (let pageStart = 0; pageStart < codes.length; pageStart += CARDS_PER_PAGE) {
          doc.addPage();
          const batch = codes.slice(pageStart, pageStart + CARDS_PER_PAGE);

          for (let slot = 0; slot < batch.length; slot += 1) {
            const pos = cardPosition(slot);
            await drawCardBack(doc, pos.x, pos.y, { websiteQr });
            drawCropMarks(doc, pos.x, pos.y);
          }
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

module.exports = {
  generateGiftCardPdf,
};
