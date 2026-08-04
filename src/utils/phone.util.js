/** رقم محلي فلسطيني: 05 + (6 وطنية | 9 جوال) + 7 أرقام */
const LOCAL_PHONE_REGEX = /^05[69]\d{7}$/;

/** واتساب: +9705 أو +9725 + (6|9) + 7 أرقام */
const WHATSAPP_REGEX = /^\+97[02]5[69]\d{7}$/;

/** E.164 — أي صيغة دولية صالحة */
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

const strip = (value) => String(value || '').trim().replace(/[\s\-()]/g, '');

/** توحيد الرقم المحلي إلى 05XXXXXXXX */
function normalizeLocalPhone(value) {
  let p = strip(value);
  if (!p) return '';

  if (p.startsWith('+')) {
    if (/^\+9705[69]\d{7}$/.test(p)) return `0${p.slice(4)}`;
    if (/^\+9725[69]\d{7}$/.test(p)) return `0${p.slice(4)}`;
    return p;
  }

  if (/^009705[69]\d{7}$/.test(p)) return `0${p.slice(5)}`;
  if (/^009725[69]\d{7}$/.test(p)) return `0${p.slice(5)}`;
  if (/^9705[69]\d{7}$/.test(p)) return `0${p.slice(3)}`;
  if (/^9725[69]\d{7}$/.test(p)) return `0${p.slice(3)}`;
  if (/^5[69]\d{7}$/.test(p)) return `0${p}`;

  return p;
}

function isValidLocalPhone(value) {
  return LOCAL_PHONE_REGEX.test(normalizeLocalPhone(value));
}

/** توحيد واتساب — يُقبل +9705/+9725 فقط (أو يُحوَّل من 05...) */
function normalizeWhatsApp(value, { defaultCountry = '970' } = {}) {
  let p = strip(value);
  if (!p) return '';

  if (/^05[69]\d{7}$/.test(p)) {
    return `+${defaultCountry}${p.slice(1)}`;
  }

  if (/^5[69]\d{7}$/.test(p)) {
    return `+${defaultCountry}5${p.slice(1)}`;
  }

  if (/^009705[69]\d{7}$/.test(p)) return `+9705${p.slice(6)}`;
  if (/^009725[69]\d{7}$/.test(p)) return `+9725${p.slice(6)}`;
  if (/^9705[69]\d{7}$/.test(p)) return `+${p}`;
  if (/^9725[69]\d{7}$/.test(p)) return `+${p}`;

  if (!p.startsWith('+')) p = `+${p}`;

  if (/^\+9705[69]\d{7}$/.test(p) || /^\+9725[69]\d{7}$/.test(p)) return p;

  return p;
}

function isValidWhatsApp(value) {
  return WHATSAPP_REGEX.test(normalizeWhatsApp(value));
}

/**
 * E.164 for Twilio/SMS — DB/storage stays on normalizeLocalPhone (05XXXXXXXX).
 * - 0591234567 / 0569876543 → +970591234567 / +970569876543
 * - +970... or other valid E.164 → unchanged
 */
function toE164ForTwilio(value) {
  const p = strip(value);
  if (!p) return '';

  if (E164_REGEX.test(p)) {
    return p;
  }

  const local = normalizeLocalPhone(p);
  if (isValidLocalPhone(local)) {
    return `+970${local.slice(1)}`;
  }

  return p;
}

/** @deprecated alias — use toE164ForTwilio */
const toE164Palestine = toE164ForTwilio;

/**
 * Single entry point for registration OTP + user phone storage.
 * @returns {{ localPhone: string, e164Phone: string }}
 */
function resolveRegistrationPhone(value) {
  const localPhone = normalizeLocalPhone(value);
  if (!localPhone || !isValidLocalPhone(localPhone)) {
    const err = new Error(LOCAL_PHONE_MESSAGE);
    err.status = 400;
    err.code = 'INVALID_PHONE';
    throw err;
  }

  return {
    localPhone,
    e164Phone: toE164ForTwilio(value),
  };
}

const LOCAL_PHONE_MESSAGE =
  'رقم فلسطيني فقط: 059 (جوال) أو 056 (وطنية) ثم 7 أرقام — 10 أرقام بالمجموع';

const WHATSAPP_MESSAGE =
  'واتساب: +9705 أو +9725 ثم 6 أو 9 و7 أرقام — مثل +970592222222 أو +972562222222';

module.exports = {
  LOCAL_PHONE_REGEX,
  WHATSAPP_REGEX,
  E164_REGEX,
  normalizeLocalPhone,
  isValidLocalPhone,
  normalizeWhatsApp,
  isValidWhatsApp,
  toE164ForTwilio,
  toE164Palestine,
  resolveRegistrationPhone,
  LOCAL_PHONE_MESSAGE,
  WHATSAPP_MESSAGE,
};
