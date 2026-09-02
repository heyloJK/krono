// daily.js — deterministic daily challenge generation.
//
// PURE module: given a date string it returns a byte-identical challenge in every
// browser. No DOM, no storage, no Date.now, no Math.random. All timing values are
// integer milliseconds.
//
// DRAW ORDER (must never be reordered — the sequence is the contract):
//   1. round 1 target step
//   2. round 2 target (rejection sampled)
//   3. round 3 duration
//   4. round 4 drift: target, bias direction, bias magnitude, jitter SD,
//      blackout fraction (5 draws, in that order — the tick train itself comes
//      from a SEPARATE stream, see generateDrift)
//   5. round 5 operand a
//   6. round 5 operand b
//   7. round 5 operator
//   8. round 5 answer distractors (3, rejection sampled)
//   9. round 5 option order (shuffle)
//  10. round 5 answer deadline

import { rngFromString, randInt, shuffle, gaussian } from './prng.js';
import { puzzleNumber } from './dates.js';

export function generateChallenge(dateStr) {
  const rng = rngFromString('chrono-' + dateStr);

  // 1. Round 1: 1.00s–9.00s in 0.25s steps (33 discrete, countable targets).
  const round1TargetMs = 1000 + randInt(rng, 0, 32) * 250;

  // 2. Round 2: 0.40s–9.00s at 2 decimals, but never a multiple of 0.25s.
  //    Wide range on purpose — short 0.xx and long 8.xx targets, not just 4–5s.
  let r2cs;
  do {
    r2cs = randInt(rng, 40, 900);
  } while (r2cs % 25 === 0);
  const round2TargetMs = r2cs * 10;

  // 3. Round 3: machine-run duration, 0.30s–9.50s at 2 decimals.
  const round3DurationMs = randInt(rng, 30, 950) * 10;

  // 4. Round 4: Drift. Five draws here; the tick train is generated separately.
  const round4 = generateDrift(rng, dateStr);

  // 5–7. Round 5 equation: a±b, result strictly positive.
  const a = randInt(rng, 11, 49);
  const b = randInt(rng, 3, 19);
  const op = rng() < 0.5 ? '+' : '−';
  let opA = a, opB = b;
  if (op === '−' && opA <= opB) {
    [opA, opB] = [opB, opA]; // keep subtraction positive without extra draws
  }
  const answer = op === '+' ? opA + opB : opA - opB;

  // 8. Three distinct wrong answers within ±1..10 of the correct one.
  const distractors = [];
  while (distractors.length < 3) {
    const mag = randInt(rng, 1, 10);
    const sign = rng() < 0.5 ? 1 : -1;
    const cand = answer + mag * sign;
    if (cand > 0 && cand !== answer && !distractors.includes(cand)) {
      distractors.push(cand);
    }
  }

  // 9. Shuffle the four options.
  const options = shuffle(rng, [answer, ...distractors]);

  // 10. Answer deadline from START, 5.00s–7.00s. NEVER displayed.
  const round5DeadlineMs = randInt(rng, 500, 700) * 10;

  return {
    date: dateStr,
    puzzleNumber: puzzleNumber(dateStr),
    round1: { targetMs: round1TargetMs },
    round2: { targetMs: round2TargetMs },
    round3: { durationMs: round3DurationMs },
    round4,
    round5: {
      a: opA, b: opB, op, answer,
      options,
      deadlineMs: round5DeadlineMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Round 4 — Drift
// ---------------------------------------------------------------------------
// The player produces an interval of length T while a tick train plays that
// LOOKS like a ruler and isn't. Every constant below is load-bearing; the
// comments say why, because narrowing any of them quietly breaks the round.
//
//  Bias 15-25%. The Weber fraction for interval timing is ~8-12% near 1s.
//    Under ~12% nobody can detect the bias, so it degenerates into a constant
//    offset applied to the whole player base and measures nothing. Over ~30%
//    the ticks stop reading as a plausible reference and are dismissed for
//    free. 15-25% is detectable but tempting. DO NOT NARROW.
//
//  Jitter SD 10-14% of the mean IOI. This is the entrainment kill switch:
//    under ~5% variability people synchronise to the sequence and it becomes a
//    metronome, which trivialises this round AND corrupts the player's timing
//    in the rounds that follow. It is PROPORTIONAL to the mean on purpose — a
//    fixed absolute SD would make a fast-reference day look visibly tighter
//    than a slow one and leak the bias direction before the ticks have worked.
//
//  Blackout 0.45-0.65 of T. Ticks stop there and the player finishes in
//    silence, so the ticks can't be counted to the finish and the error lands
//    in the unsupported stretch where it belongs.
const DRIFT_TARGET_MIN_MS = 4500;
const DRIFT_TARGET_MAX_MS = 8000;
const DRIFT_BIAS_MIN_TENTHS = 150;  // 15.0%
const DRIFT_BIAS_MAX_TENTHS = 250;  // 25.0%
const DRIFT_JITTER_MIN_TENTHS = 100; // SD = 10.0% of the mean IOI
const DRIFT_JITTER_MAX_TENTHS = 140; // SD = 14.0% of the mean IOI
const DRIFT_BLACKOUT_MIN = 450;      // 0.450 of T, in thousandths
const DRIFT_BLACKOUT_MAX = 650;      // 0.650 of T, in thousandths
const DRIFT_JITTER_CLAMP_SD = 2.5;   // no single gap may be absurd
const DRIFT_MIN_IOI_MS = 60;         // hard floor after jitter, so two ticks never collide
const DRIFT_MAX_TICKS = 40;          // loop guard; the real ceiling is ~7

function generateDrift(rng, dateStr) {
  // Draw 1: target duration, 4.50s-8.00s at 2 decimals.
  const targetMs = randInt(rng, DRIFT_TARGET_MIN_MS / 10, DRIFT_TARGET_MAX_MS / 10) * 10;

  // Draws 2-3: which way the reference lies, and by how much.
  const dir = rng() < 0.5 ? 'fast' : 'slow';
  const biasTenths = randInt(rng, DRIFT_BIAS_MIN_TENTHS, DRIFT_BIAS_MAX_TENTHS);
  // biasTenths is tenths of a percent of 1000ms, i.e. exactly the ms offset:
  // 220 tenths = 22.0% = 220ms. Fast runs short, slow runs long.
  const meanIoiMs = dir === 'fast' ? 1000 - biasTenths : 1000 + biasTenths;

  // Draw 4: jitter, as a fraction of THIS day's mean IOI (never absolute).
  const jitterTenths = randInt(rng, DRIFT_JITTER_MIN_TENTHS, DRIFT_JITTER_MAX_TENTHS);
  const jitterSdMs = Math.round((meanIoiMs * jitterTenths) / 1000);

  // Draw 5: where the ticks stop.
  const blackoutThousandths = randInt(rng, DRIFT_BLACKOUT_MIN, DRIFT_BLACKOUT_MAX);
  const blackoutMs = Math.round((targetMs * blackoutThousandths) / 1000);

  // The tick train takes a VARIABLE number of draws (two per tick, and the tick
  // count depends on the values above), so it runs on its own stream. Sharing
  // the main stream would make round 5's content depend on how many ticks this
  // day happens to have, which is a needless coupling.
  const tickRng = rngFromString('chrono-drift-' + dateStr);
  const tickOffsetsMs = [];
  let t = 0;
  for (let i = 0; i < DRIFT_MAX_TICKS; i++) {
    const z = Math.max(-DRIFT_JITTER_CLAMP_SD, Math.min(DRIFT_JITTER_CLAMP_SD, gaussian(tickRng)));
    t += Math.max(DRIFT_MIN_IOI_MS, Math.round(meanIoiMs + z * jitterSdMs));
    if (t > blackoutMs) break;   // past the blackout: the rest is silence
    tickOffsetsMs.push(t);       // onset measured from the player's start press
  }

  return {
    targetMs,
    biasDir: dir,               // 'fast' = ticks run short, 'slow' = ticks run long
    biasPct: biasTenths / 10,   // 22 => the reference ran 22% off a real second
    meanIoiMs,
    jitterSdMs,
    blackoutMs,
    tickOffsetsMs,
  };
}
