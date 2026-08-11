function getCurrentMonthKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getPreviousMonthKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return getCurrentMonthKey(d);
}

function isMonthKeyExpired(monthKey, date = new Date()) {
  return monthKey !== getCurrentMonthKey(date);
}

function sanitizeExportFilename(name) {
  const cleaned = String(name || "store")
    .replace(/[^\w\u0600-\u06FF\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return cleaned || "store";
}

function addMonthsToMonthKey(monthKey, months = 1) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!year || !month) return getCurrentMonthKey();
  const date = new Date(year, month - 1 + months, 1);
  return getCurrentMonthKey(date);
}

function monthKeyToReferenceDate(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!year || !month) return new Date();
  return new Date(year, month - 1, 1);
}

module.exports = {
  getCurrentMonthKey,
  getPreviousMonthKey,
  isMonthKeyExpired,
  sanitizeExportFilename,
  addMonthsToMonthKey,
  monthKeyToReferenceDate,
};
