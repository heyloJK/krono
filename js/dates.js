// dates.js — UTC date utilities. The daily challenge is keyed to the UTC date so
// that everyone on Earth plays the same puzzle and it resets at midnight UTC.

// Day one. Moving this shifts every puzzle number and nothing else — set it to
// the real public launch date when there is one.
export const LAUNCH_EPOCH = '2026-08-30'; // Puzzle #1 (friends-testing deploy).

// Current UTC date as "YYYY-MM-DD".
export function todayUTC(now = new Date()) {
  return toDateString(now);
}

export function toDateString(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Parse "YYYY-MM-DD" to a UTC-midnight Date.
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Whole days between two date strings (b - a).
export function daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / MS);
}

// Puzzle number for a given date string: days since the launch epoch, +1.
export function puzzleNumber(dateStr) {
  return daysBetween(LAUNCH_EPOCH, dateStr) + 1;
}

// The date string for the previous day.
export function previousDay(dateStr) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateString(d);
}

// The date string for the next day.
export function nextDay(dateStr) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return toDateString(d);
}

// Milliseconds until the next UTC midnight, from `now`.
export function msUntilNextUTCMidnight(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.getTime() - now.getTime();
}
