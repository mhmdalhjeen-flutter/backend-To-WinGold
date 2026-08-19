const DEFAULT_CUSTOMER_APP_URL = "https://wingolgmoll.com";
const LEGACY_CUSTOMER_HOSTS = new Set([
  "win-gold-shopping.mhmdalhjeen.workers.dev",
]);

function normalizeWebsiteBase(url) {
  let base = String(url || DEFAULT_CUSTOMER_APP_URL).trim();
  base = base.replace(/^(?:https?:\/\/)+/i, "https://");
  if (base && !/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  base = base.replace(/\/$/, "");
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (LEGACY_CUSTOMER_HOSTS.has(host)) {
      return DEFAULT_CUSTOMER_APP_URL;
    }
  } catch {
    /* keep normalized base */
  }
  return base;
}

function normalizeGiftCodeForQr(code) {
  const raw = String(code || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const fromGift = parsed.searchParams.get("gift");
      if (fromGift) return fromGift.trim();
    } catch {
      /* use raw code below */
    }
  }
  return raw;
}

function getCustomerAppUrl() {
  return normalizeWebsiteBase(process.env.CUSTOMER_APP_URL || DEFAULT_CUSTOMER_APP_URL);
}

function buildGiftActivationUrl(websiteUrl, code) {
  const base = normalizeWebsiteBase(websiteUrl || DEFAULT_CUSTOMER_APP_URL);
  const giftCode = normalizeGiftCodeForQr(code);
  return `${base}/?gift=${encodeURIComponent(giftCode)}`;
}

module.exports = {
  getCustomerAppUrl,
  buildGiftActivationUrl,
};
