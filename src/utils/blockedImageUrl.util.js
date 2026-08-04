/**
 * Google search thumbnail / scraped image URLs — never serve or persist.
 * Sources: legacy store.logo, store.coverImage, offer.image, product.image, chat itemImage.
 */

const BLOCKED_PATTERNS = [
  /encrypted-tbn0\.gstatic\.com/i,
  /\/images\?q=tbn/i,
  /[?&]tbn[=:]/i,
  /gstatic\.com\/images\?.*tbn/i,
];

function isBlockedExternalImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  return BLOCKED_PATTERNS.some((re) => re.test(trimmed));
}

/** Return null for blocked URLs; otherwise the original string (trimmed). */
function sanitizeStoredImageUrl(url) {
  if (url == null) return url;
  if (typeof url !== "string") return url;
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (isBlockedExternalImageUrl(trimmed)) return null;
  return trimmed;
}

module.exports = {
  isBlockedExternalImageUrl,
  sanitizeStoredImageUrl,
};
