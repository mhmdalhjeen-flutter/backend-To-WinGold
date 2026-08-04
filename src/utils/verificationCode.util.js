const Order = require('../models/order');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function randomDigits() {
  return String(Math.floor(Math.random() * 100000)).padStart(5, '0');
}

function buildVerificationCode() {
  return `${randomLetter()}${randomLetter()}${randomDigits()}`;
}

/**
 * Generate a unique offline order verification code: 2 letters + 5 digits (e.g. AB12345).
 */
async function generateUniqueVerificationCode(session = null) {
  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = buildVerificationCode();
    let query = Order.findOne({ verificationCode: code }).select('_id');
    if (session) query = query.session(session);
    const exists = await query.lean();
    if (!exists) return code;
  }
  const err = new Error('تعذّر إنشاء رمز التحقق — حاول مرة أخرى');
  err.status = 500;
  throw err;
}

module.exports = { generateUniqueVerificationCode, buildVerificationCode };
