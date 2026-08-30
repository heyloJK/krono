// storage.js — local persistence. Single namespaced root key. Versioned schema.
// Corrupt or unreadable state resets to defaults silently; storage never blocks
// play. All durations stored as integer milliseconds.

import { previousDay, daysBetween } from './dates.js';

const KEY = 'chrono';
const VERSION = 1;
const MAX_HISTORY = 60;

export function defaults() {
  return {
    version: VERSION,
    lastPlayed: null,
    streak: { current: 0, best: 0, lastDate: null },
    personalBest: { total: null, date: null },
    // signedSumMs / targetSumMs power the "runs late/early" bias as a % of target.
    lifetime: { days: 0, totalMs: 0, signedSumMs: 0, targetSumMs: 0, roundCount: 0 },
    history: [],
    session: null,
    muted: false, // sound + haptics preference, device-level (not per-session)
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION) {
      return defaults();
    }
    // Merge onto defaults so a partial/older object never crashes a reader.
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

export function save(root) {
  try {
    localStorage.setItem(KEY, JSON.stringify(root));
  } catch {
    // Out of quota / disabled storage — ignore. The game stays playable.
  }
}

// --- Session (in-progress day) --------------------------------------------

// A session is the persisted progress for the current day, so a refresh resumes
// the correct round and an abandoned session still counts as played.
export function newSession(date, puzzleNumber) {
  return {
    date,
    puzzleNumber,
    currentRound: 1,
    rounds: [],          // completed round score objects, index 0..4
    round5Started: false,
    completed: false,
  };
}

// --- Finalizing a completed day -------------------------------------------

// Fold a finished day into the persistent stats. Returns { beatPB }.
export function finalizeDay(root, day) {
  const { date, totalMs, bands, signedSumMs, targetSumMs, roundCount } = day;

  // Streak: increments only across consecutive days; a gap of 2+ resets to 1.
  const last = root.streak.lastDate;
  if (last === date) {
    // already counted (defensive) — leave as is
  } else if (last === previousDay(date)) {
    root.streak.current += 1;
  } else {
    root.streak.current = 1;
  }
  root.streak.best = Math.max(root.streak.best, root.streak.current);
  root.streak.lastDate = date;

  // Personal best: lower total is better.
  let beatPB = false;
  if (root.personalBest.total == null || totalMs < root.personalBest.total) {
    root.personalBest = { total: totalMs, date };
    beatPB = root.lifetime.days > 0; // not "beaten" on the very first day
  }

  // Lifetime aggregates.
  root.lifetime.days += 1;
  root.lifetime.totalMs += totalMs;
  root.lifetime.signedSumMs += signedSumMs;
  root.lifetime.targetSumMs += targetSumMs;
  root.lifetime.roundCount += roundCount;

  // History, newest last, capped.
  root.history.push({ date, totalMs, bands });
  if (root.history.length > MAX_HISTORY) {
    root.history = root.history.slice(-MAX_HISTORY);
  }

  root.lastPlayed = date;
  return { beatPB };
}

// Lifetime average day total in ms (or null if never played).
export function lifetimeAverageMs(root) {
  if (root.lifetime.days === 0) return null;
  return root.lifetime.totalMs / root.lifetime.days;
}

// Signed timing bias as a percentage of target. Positive = runs late/over.
export function biasPercent(root) {
  if (root.lifetime.targetSumMs === 0) return 0;
  return (root.lifetime.signedSumMs / root.lifetime.targetSumMs) * 100;
}

// "runs +0.3% late" / "runs -0.2% early" / "runs on time".
export function biasString(root) {
  const pct = biasPercent(root);
  if (Math.abs(pct) < 0.05) return 'runs on time';
  const sign = pct > 0 ? '+' : '−';
  const word = pct > 0 ? 'late' : 'early';
  return `runs ${sign}${Math.abs(pct).toFixed(1)}% ${word}`;
}
