const DEFAULT_CUSTOMER_APP_URL = "https://wingolgmoll.com";

function normalizeWebsiteBase(url) {
  let base = String(url || DEFAULT_CUSTOMER_APP_URL).trim();
  base = base.replace(/^(?:https?:\/\/)+/i, "https://");
  if (base && !/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  return base.replace(/\/$/, "");
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
