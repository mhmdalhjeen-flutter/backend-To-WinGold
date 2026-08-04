const sharp = require("sharp");
const { isBlockedExternalImageUrl } = require("./blockedImageUrl.util");

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/i;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const FORMAT_TO_MIME = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const DEFAULT_MAX_BYTES = 1_200_000;
const MAX_PIXELS = 16_000_000;

function badImage(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function isCloudinaryUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    const host = hostname.toLowerCase();
    return host === "res.cloudinary.com" || host.endsWith(".cloudinary.com") || host === "cloudinary.com";
  } catch {
    return false;
  }
}

function assertTrustedHttps(trimmed, previousValue) {
  if (isCloudinaryUrl(trimmed)) return;
  const prev = typeof previousValue === "string" ? previousValue.trim() : "";
  if (prev && trimmed === prev) return;
  throw badImage("يجب رفع الصورة عبر النظام — الروابط الخارجية غير مسموحة");
}

function parseDataUrl(str) {
  if (typeof str !== "string" || !str.startsWith("data:")) return null;
  const match = str.match(DATA_URL_RE);
  if (!match) return null;
  const base64 = match[2].replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw badImage("صيغة الصورة غير صالحة");
  }
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(base64, "base64") };
}

async function validateImageInput(input, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const parsed = parseDataUrl(input);
  if (!parsed) return null;

  if (!ALLOWED_MIME.has(parsed.mime)) {
    throw badImage("نوع الصورة غير مسموح");
  }
  if (!parsed.buffer.length || parsed.buffer.length > maxBytes) {
    throw badImage("حجم الصورة غير صالح أو كبير جداً");
  }

  let meta;
  try {
    meta = await sharp(parsed.buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw badImage("ملف الصورة غير صالح");
  }

  const actualMime = FORMAT_TO_MIME[meta.format];
  if (!actualMime || actualMime !== parsed.mime) {
    throw badImage("نوع الصورة لا يطابق محتواها");
  }
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) {
    throw badImage("أبعاد الصورة غير صالحة أو كبيرة جداً");
  }

  return { ...parsed, meta };
}

/**
 * يحوّل data URL إلى WebP مضغوط (نفس الحقل — لا تغيير API).
 * مع enforceCloudinaryHttps: روابط https الجديدة يجب أن تكون من Cloudinary؛
 * الروابط الخارجية القديمة تُقبل فقط إن طابقت previousValue.
 */
async function processDataUrlImage(
  input,
  {
    maxWidth = 1200,
    quality = 82,
    thumbnail = false,
    maxBytes = DEFAULT_MAX_BYTES,
    previousValue,
    enforceCloudinaryHttps = false,
  } = {}
) {
  if (typeof input !== "string" || !input.trim()) return input;
  const trimmed = input.trim();
  if (trimmed.startsWith("http://")) throw badImage("روابط الصور غير الآمنة غير مسموحة");
  if (trimmed.startsWith("https://")) {
    if (isBlockedExternalImageUrl(trimmed)) return null;
    if (enforceCloudinaryHttps) assertTrustedHttps(trimmed, previousValue);
    return trimmed;
  }
  if (!trimmed.startsWith("data:")) throw badImage("صيغة الصورة غير مدعومة");

  const parsed = await validateImageInput(trimmed, { maxBytes });
  if (!parsed) throw badImage("صيغة الصورة غير صالحة");

  try {
    const width = thumbnail ? 320 : maxWidth;
    const q = thumbnail ? 70 : quality;
    const out = await sharp(parsed.buffer)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: q, effort: 4 })
      .toBuffer();
    return `data:image/webp;base64,${out.toString("base64")}`;
  } catch {
    throw badImage("تعذّرت معالجة الصورة");
  }
}

async function processDataUrlImages(inputs, opts) {
  if (!Array.isArray(inputs)) return inputs;
  return Promise.all(inputs.map((img) => processDataUrlImage(img, opts)));
}

async function processOptionalImage(input, opts) {
  if (!input || (typeof input === "string" && !input.trim())) return input;
  return processDataUrlImage(input, opts);
}

module.exports = {
  validateImageInput,
  processDataUrlImage,
  processDataUrlImages,
  processOptionalImage,
  isCloudinaryUrl,
};
