function getCustomerAppUrl() {
  return (process.env.CUSTOMER_APP_URL || "https://win-gold-shopping.mhmdalhjeen.workers.dev").replace(/\/$/, "");
}

function buildGiftActivationUrl(websiteUrl, code) {
  const base = String(websiteUrl || "").replace(/\/$/, "");
  return `${base}/?gift=${encodeURIComponent(code)}`;
}

module.exports = {
  getCustomerAppUrl,
  buildGiftActivationUrl,
};
