// scoring.js — PURE scoring and banding. No DOM, no storage. Everything in
// integer milliseconds; seconds are only produced for display by format().

export const CAP_MS = 1500;          // Per-round error cap.
export const MATH_PENALTY_MS = 500;  // Round 5 wrong-answer penalty.
export const TIMEOUT_MS = 2000;      // Round 5 flat score on timeout/abandon.
export const GUESS_EXPIRE_MS = 1500; // Round 5 base when the guess phase expires.

// Bands from the UNCAPPED error, judged in DISPLAYED centiseconds (cs = ms/10),
// best-first: perfect only at a dead-0 offset, then <20cs, then <50cs, then 50+cs.
export const BANDS = [
  { name: 'perfect', glyph: '💎', label: 'Perfect', maxCs: 0 },
  { name: 'green', glyph: '🟩', label: 'Green', maxCs: 19 },
  { name: 'yellow', glyph: '🟨', label: 'Yellow', maxCs: 49 },
  { name: 'red', glyph: '🟥', label: 'Red', maxCs: Infinity },
];

const BAND_BY_NAME = Object.fromEntries(BANDS.map((b) => [b.name, b]));

export function bandForErrorMs(rawErrorMs) {
  const cs = Math.round(rawErrorMs / 10); // the offset as it is shown (S:CC)
  return BANDS.find((b) => cs <= b.maxCs) || BANDS[BANDS.length - 1];
}

export function glyphForBand(name) {
  return (BAND_BY_NAME[name] || BAND_BY_NAME.red).glyph;
}

// Score a standard round. `actualMs` is what the player produced (a held
// duration or an estimate); `targetMs` is the truth being compared against.
// `capMs` is per-round so round 4 can run looser (see scoreDrift).
export function scoreRound(actualMs, targetMs, { capMs = CAP_MS } = {}) {
  const rawErrorMs = Math.abs(actualMs - targetMs);
  const cappedErrorMs = Math.min(rawErrorMs, capMs);
  const signedMs = actualMs - targetMs; // + = over/late, - = under/early
  const relError = rawErrorMs / (targetMs + 600);
  return {
    actualMs,
    targetMs,
    rawErrorMs,
    cappedErrorMs,
    scoreMs: cappedErrorMs, // contribution to the day total
    signedMs,
    relError,
    band: bandForErrorMs(rawErrorMs).name,
  };
}

// Round 5 scoring. Distinct outcomes, in priority order:
//   'timeout'  — no answer before deadline, or tab/window abandoned, or refresh.
//                Flat TIMEOUT_MS, no guess phase, no band credit.
//   'expired'  — answered, but the 60s guess phase ran out. GUESS_EXPIRE_MS plus
//                the math penalty if the answer was wrong.
//   'answered' — normal path: capped error + math penalty.
// The cap is applied BEFORE the math penalty, so a wrong-math round tops out at
// CAP_MS + MATH_PENALTY_MS = 2000ms.
export function scoreRound5(outcome, opts = {}) {
  const mathWrong = opts.mathCorrect === false;
  const penalty = mathWrong ? MATH_PENALTY_MS : 0;

  if (outcome === 'timeout') {
    return {
      outcome, scoreMs: TIMEOUT_MS, band: 'red',
      rawErrorMs: null, signedMs: null, relError: null,
      mathCorrect: opts.mathCorrect ?? null, targetMs: opts.targetMs ?? null,
      actualMs: null,
    };
  }

  if (outcome === 'expired') {
    return {
      outcome, scoreMs: GUESS_EXPIRE_MS + penalty, band: 'red',
      rawErrorMs: null, signedMs: null, relError: null,
      mathCorrect: opts.mathCorrect, targetMs: opts.targetMs ?? null,
      actualMs: null,
    };
  }

  // 'answered'
  const base = scoreRound(opts.actualMs, opts.targetMs);
  return {
    outcome,
    scoreMs: base.cappedErrorMs + penalty,
    band: base.band,
    rawErrorMs: base.rawErrorMs,
    cappedErrorMs: base.cappedErrorMs,
    signedMs: base.signedMs,
    relError: base.relError,
    mathCorrect: opts.mathCorrect,
    targetMs: opts.targetMs,
    actualMs: opts.actualMs,
  };
}

// Round 4 (Drift) — interval production against a deliberately miscalibrated
// tick reference. Scored exactly like the other production rounds (|actual −
// target|, same bands) with ONE difference: a looser cap.
//
// The cap has to be looser because the day's false reference drags the entire
// player base the same way. Correlated error is the expected outcome here, not
// an outlier to be clipped — at the blind rounds' 1.50s cap a whole cohort
// would pile up on the ceiling and the round would stop discriminating. This is
// a calibrated guess; retune it against real data, and nothing else, so scores
// stay comparable across the change.
export const DRIFT_CAP_MS = 3000;

export function scoreDrift(actualMs, targetMs) {
  const base = scoreRound(actualMs, targetMs, { capMs: DRIFT_CAP_MS });
  return {
    ...base,
    // Kept out of the lifetime early/late aggregate. This round's signed error
    // is deliberately pushed by the day's reference, so it measures the bias,
    // not the player's own clock — folding it in would corrupt the readout.
    biasEligible: false,
  };
}

// Which way the day's reference pulls: a fast reference (short IOIs) makes the
// interval feel longer than it is, so the player marks EARLY (negative signed
// error); a slow reference pulls late. Returns -1 or +1.
export function driftPull(biasDir) {
  return biasDir === 'fast' ? -1 : 1;
}

// Did the player go the way the reference pushed? Sign agreement, nothing more.
// A dead-0 mark followed nothing.
export function followedDrift(signedMs, biasDir) {
  return signedMs != null && signedMs !== 0 && Math.sign(signedMs) === driftPull(biasDir);
}

// Day tiers. Derived from the STORED score — the capped, authoritative total —
// never from the share block's displayed headline, which is rounded for
// readability. Placeholder bands: they want real distributions before being
// pinned, which is why they live here as one named table rather than inline.
export const TIER_BANDS = [
  { name: 'OBSERVATORY', underMs: 400 },
  { name: 'MASTER CHRONOMETER', underMs: 800 },
  { name: 'CHRONOMETER', underMs: 1600 },
  { name: 'REGULATED', underMs: Infinity },
];

export function tierForTotalMs(totalMs) {
  return (TIER_BANDS.find((b) => totalMs < b.underMs) || TIER_BANDS[TIER_BANDS.length - 1]).name;
}

// Sum of per-round score contributions → day total (ms).
export function dayTotalMs(rounds) {
  return rounds.reduce((sum, r) => sum + r.scoreMs, 0);
}

// Display helper: ms → "S.CC" seconds string.
export function format(ms) {
  return (ms / 1000).toFixed(2);
}
