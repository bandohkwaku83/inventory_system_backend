const { roundMoney } = require("./purchaseTotals");

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function toDateKey(d) {
  return d.toISOString().slice(0, 10);
}

function parseDays(raw, fallback = 7) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.floor(n), 90);
}

function parseLimit(raw, fallback = 10) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.floor(n), 100);
}

function percentChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) {
    return cur === 0 ? 0 : 100;
  }
  return roundMoney(((cur - prev) / prev) * 100);
}

/** Last N calendar days ending today (inclusive), oldest first */
function buildDayRange(days) {
  const today = startOfDay(new Date());
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    series.push({
      date: toDateKey(date),
      day: DAY_LABELS[date.getUTCDay()],
      start: startOfDay(date),
      end: endOfDay(date),
    });
  }
  return series;
}

function fillDailySeries(dayRange, rows, valueKey = "amount") {
  const byDate = new Map(
    rows.map((row) => [String(row._id || row.date), row])
  );

  return dayRange.map(({ date, day }) => {
    const row = byDate.get(date);
    return {
      date,
      day,
      [valueKey]: roundMoney(row?.[valueKey] ?? row?.revenue ?? 0),
      ...(row?.count !== undefined ? { count: row.count } : {}),
    };
  });
}

function formatItemsSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  return items
    .map((item) => `${item.name} x${item.quantity}`)
    .join(", ");
}

function formatRestockQuantity(quantity, unit) {
  const qty = Number(quantity) || 0;
  if (!unit || unit === "units") {
    return `${qty} units`;
  }
  return `${qty} ${unit}`;
}

module.exports = {
  DAY_LABELS,
  startOfDay,
  endOfDay,
  addDays,
  toDateKey,
  parseDays,
  parseLimit,
  percentChange,
  buildDayRange,
  fillDailySeries,
  formatItemsSummary,
  formatRestockQuantity,
};
