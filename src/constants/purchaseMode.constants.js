const PURCHASE_MODES = Object.freeze(['quantity', 'price', 'both']);
const PURCHASE_METHODS = Object.freeze(['quantity', 'price']);

function normalizePurchaseMode(value) {
  const v = String(value || 'quantity').toLowerCase().trim();
  return PURCHASE_MODES.includes(v) ? v : 'quantity';
}

function normalizePurchaseMethod(value) {
  const v = String(value || 'quantity').toLowerCase().trim();
  return PURCHASE_METHODS.includes(v) ? v : 'quantity';
}

function assertPurchaseMethodAllowed(productPurchaseMode, method) {
  const mode = normalizePurchaseMode(productPurchaseMode);
  const m = normalizePurchaseMethod(method);
  if (m === 'quantity' && mode === 'price') {
    const err = new Error('هذا العنصر يُباع بالقيمة فقط — أدخل المبلغ المطلوب');
    err.status = 400;
    throw err;
  }
  if (m === 'price' && mode === 'quantity') {
    const err = new Error('هذا العنصر يُباع بالكمية فقط');
    err.status = 400;
    throw err;
  }
  return m;
}

function parseRequestedAmount(raw, label = 'القيمة المطلوبة') {
  const amount = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error(`${label} يجب أن تكون أكبر من صفر`);
    err.status = 400;
    throw err;
  }
  if (amount > 10_000_000) {
    const err = new Error(`${label} كبيرة جداً`);
    err.status = 400;
    throw err;
  }
  return Math.round(amount * 100) / 100;
}

module.exports = {
  PURCHASE_MODES,
  PURCHASE_METHODS,
  normalizePurchaseMode,
  normalizePurchaseMethod,
  assertPurchaseMethodAllowed,
  parseRequestedAmount,
};
