const VALID_PERIODS = ["day", "week", "month", "year"];

const REGION_LABELS = {
  North: "الشمال",
  Gaza: "غزة",
  Middle: "الوسط",
  South: "الجنوب",
  Rafah: "رفح",
};

function normalizePeriod(period) {
  return VALID_PERIODS.includes(period) ? period : "week";
}

function getPeriodBounds(period) {
  const p = normalizePeriod(period);
  const end = new Date();
  const start = new Date(end);
  let prevStart;
  let prevEnd;

  switch (p) {
    case "day":
      start.setHours(0, 0, 0, 0);
      prevEnd = new Date(start);
      prevEnd.setMilliseconds(-1);
      prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 1);
      break;
    case "week":
      start.setDate(end.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      prevEnd = new Date(start);
      prevEnd.setMilliseconds(-1);
      prevStart = new Date(prevEnd);
      prevStart.setDate(prevStart.getDate() - 6);
      prevStart.setHours(0, 0, 0, 0);
      break;
    case "month":
      start.setMonth(end.getMonth() - 1);
      start.setHours(0, 0, 0, 0);
      prevEnd = new Date(start);
      prevEnd.setMilliseconds(-1);
      prevStart = new Date(prevEnd);
      prevStart.setMonth(prevStart.getMonth() - 1);
      prevStart.setHours(0, 0, 0, 0);
      break;
    case "year":
    default:
      start.setFullYear(end.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      prevEnd = new Date(start);
      prevEnd.setMilliseconds(-1);
      prevStart = new Date(prevEnd);
      prevStart.setFullYear(prevStart.getFullYear() - 1);
      prevStart.setHours(0, 0, 0, 0);
      break;
  }

  return { period: p, start, end, prevStart, prevEnd };
}

function growthRate(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function formatDayLabel(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
}

function formatMonthLabel(isoMonth) {
  const [y, m] = isoMonth.split("-");
  return `${parseInt(m, 10)}/${y}`;
}

function buildDailySeries(rows, start, end) {
  const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const keys = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);

  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys.map((date) => ({
    date,
    label: formatDayLabel(date),
    count: map[date] || 0,
  }));
}

function buildMonthlySeries(rows, months = 12) {
  const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const series = [];
  const end = new Date();
  end.setDate(1);
  end.setHours(0, 0, 0, 0);

  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setMonth(end.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    series.push({ month: key, label: formatMonthLabel(key), count: map[key] || 0 });
  }
  return series;
}

/** مراكز تقريبية للمناطق — جاهزة لربط خريطة حقيقية لاحقاً */
const REGION_GEO = {
  North: { lat: 32.8, lng: 35.17, label: REGION_LABELS.North },
  Gaza: { lat: 31.5, lng: 34.47, label: REGION_LABELS.Gaza },
  Middle: { lat: 31.9, lng: 35.2, label: REGION_LABELS.Middle },
  South: { lat: 31.34, lng: 34.31, label: REGION_LABELS.South },
  Rafah: { lat: 31.28, lng: 34.25, label: REGION_LABELS.Rafah },
};

module.exports = {
  VALID_PERIODS,
  REGION_LABELS,
  REGION_GEO,
  normalizePeriod,
  getPeriodBounds,
  growthRate,
  buildDailySeries,
  buildMonthlySeries,
};
