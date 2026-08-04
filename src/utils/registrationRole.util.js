const VALID_ROLES = new Set(["store", "supplier"]);

/** يحدد دور التسجيل من الحقل المخزّن أو بادئة الكود الصريحة — لا substring. */
function resolveRegistrationRole(promo, normalizedCode) {
  if (promo?.registrationRole && VALID_ROLES.has(promo.registrationRole)) {
    return promo.registrationRole;
  }

  const code = String(normalizedCode || "").trim().toUpperCase();
  if (/^STORE[-_][A-Z0-9]+$/i.test(code) || /^REG[-_]STORE[-_]/i.test(code)) {
    return "store";
  }
  if (/^SUPPLIER[-_][A-Z0-9]+$/i.test(code) || /^REG[-_]SUPPLIER[-_]/i.test(code)) {
    return "supplier";
  }

  return null;
}

module.exports = { resolveRegistrationRole, VALID_ROLES };
