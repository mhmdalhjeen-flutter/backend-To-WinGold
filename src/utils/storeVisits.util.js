/** Calendar month key, e.g. 2026-07 */
function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Visits counted for the current calendar month (0 if stored month differs). */
function resolveMonthlyVisits(store) {
  if (!store) return 0;
  const key = currentMonthKey();
  if (store.monthlyVisitsKey !== key) return 0;
  return store.monthlyVisits || 0;
}

/** Reset monthly bucket when month changes, then increment. Keeps totalVisits cumulative. */
function incrementStoreVisits(store) {
  const key = currentMonthKey();
  if (store.monthlyVisitsKey !== key) {
    store.monthlyVisits = 0;
    store.monthlyVisitsKey = key;
  }
  store.monthlyVisits = (store.monthlyVisits || 0) + 1;
  store.totalVisits = (store.totalVisits || 0) + 1;
  store.todayVisits = (store.todayVisits || 0) + 1;
}

module.exports = {
  currentMonthKey,
  resolveMonthlyVisits,
  incrementStoreVisits,
};
