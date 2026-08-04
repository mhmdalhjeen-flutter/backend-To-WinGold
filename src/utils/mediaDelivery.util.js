const { isBlockedExternalImageUrl, sanitizeStoredImageUrl } = require("./blockedImageUrl.util");

function parseDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
}

/** Replace stripped data URLs with a fetchable API path for list responses. */
function resolveListImageField(row, resource) {
  if (!row || typeof row !== "object") return row;
  const copy = { ...row };
  const id = String(copy._id);

  if (isDataUrl(copy.image)) {
    copy.hasImage = true;
    copy.image = `/${resource}/${id}/image`;
  } else {
    const safe = sanitizeStoredImageUrl(copy.image);
    if (safe !== copy.image) copy.image = safe;
    copy.hasImage = !!copy.image;
  }

  return copy;
}

/** Replace embedded store logo/cover data URLs with fetchable API paths. */
function resolveStoreMediaFields(store) {
  if (!store || typeof store !== "object") return store;
  const copy = { ...store };
  if (!copy._id) return copy;

  const id = String(copy._id);

  if (isDataUrl(copy.logo)) {
    copy.hasLogo = true;
    copy.logo = `/stores/${id}/logo`;
  } else {
    const safeLogo = sanitizeStoredImageUrl(copy.logo);
    if (safeLogo !== copy.logo) copy.logo = safeLogo;
    copy.hasLogo = !!copy.logo;
  }

  if (isDataUrl(copy.coverImage)) {
    copy.hasCoverImage = true;
    copy.coverImage = `/stores/${id}/cover`;
  } else if ("coverImage" in copy) {
    const safeCover = sanitizeStoredImageUrl(copy.coverImage);
    if (safeCover !== copy.coverImage) copy.coverImage = safeCover;
    copy.hasCoverImage = !!copy.coverImage;
  }

  return copy;
}

async function deliverStoredImage(res, image) {
  if (!image || typeof image !== "string") {
    return res.status(404).end();
  }

  if (image.startsWith("https://") || image.startsWith("http://")) {
    if (isBlockedExternalImageUrl(image)) {
      return res.status(404).end();
    }
    return res.redirect(302, image);
  }

  const parsed = parseDataUrl(image);
  if (!parsed) {
    return res.status(404).end();
  }

  res.set("Cache-Control", "public, max-age=86400");
  return res.type(parsed.mime).send(parsed.buffer);
}

module.exports = {
  parseDataUrl,
  isDataUrl,
  resolveListImageField,
  resolveStoreMediaFields,
  deliverStoredImage,
};
