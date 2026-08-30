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

// Score a standard round (1–4). `actualMs` is what the player produced (a held
// duration or an estimate); `targetMs` is the truth being compared against.
export function scoreRound(actualMs, targetMs) {
  const rawErrorMs = Math.abs(actualMs - targetMs);
  const cappedErrorMs = Math.min(rawErrorMs, CAP_MS);
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

// Round 4 (reaction / F1 start lights) uses its own fixed-cost tiers instead of
// the shared BANDS — each tier adds a FLAT number of centiseconds to the day
// total, not the raw reaction time itself. Tiers are in DISPLAYED centiseconds
// (cs = ms/10), best-first, upper bound inclusive.
export const REACTION_BANDS = [
  { name: 'perfect', glyph: '💎', label: 'Perfect', maxCs: 24, addCs: 0 },
  { name: 'green', glyph: '🟩', label: 'Green', maxCs: 29, addCs: 10 },
  { name: 'yellow', glyph: '🟨', label: 'Yellow', maxCs: 34, addCs: 20 },
  { name: 'red', glyph: '🟥', label: 'Red', maxCs: Infinity, addCs: 30 },
];
export const REACTION_MISS_CS = 50; // jump start or no reaction at all

export function bandForReactionMs(reactionMs) {
  const cs = Math.round(reactionMs / 10);
  return REACTION_BANDS.find((b) => cs <= b.maxCs) || REACTION_BANDS[REACTION_BANDS.length - 1];
}

// Round 4 (reaction / F1 start lights). The player reacts when the lights go out;
// `reactionMs` is their reaction time (time after lights-out). A jump start
// (reacting before lights-out) or never reacting at all is a miss: flat
// REACTION_MISS_CS, no band credit. Reaction is a different skill from interval
// estimation, so it is flagged biasEligible:false and kept out of the
// timing-bias aggregate.
export function scoreReaction(reactionMs, { jumpStart = false, noReaction = false } = {}) {
  if (jumpStart || noReaction) {
    const scoreMs = REACTION_MISS_CS * 10;
    return {
      jumpStart, noReaction,
      scoreMs,
      band: 'off',
      rawErrorMs: null, cappedErrorMs: scoreMs,
      signedMs: null, relError: null, biasEligible: false,
      reactionMs: null, targetMs: 0, actualMs: null,
    };
  }
  const band = bandForReactionMs(reactionMs);
  const scoreMs = band.addCs * 10;
  return {
    jumpStart: false, noReaction: false,
    scoreMs,
    band: band.name,
    rawErrorMs: reactionMs,
    cappedErrorMs: scoreMs,
    signedMs: reactionMs,          // always "late" — logged, but not bias-eligible
    relError: reactionMs / 600,
    biasEligible: false,
    reactionMs,
    targetMs: 0,
    actualMs: reactionMs,
  };
}

// Sum of per-round score contributions → day total (ms).
export function dayTotalMs(rounds) {
  return rounds.reduce((sum, r) => sum + r.scoreMs, 0);
}

// Display helper: ms → "S.CC" seconds string.
export function format(ms) {
  return (ms / 1000).toFixed(2);
}
