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
//   4. round 4 hold (seeded delay from all-five-lit to lights-out)
//   5. round 5 operand a
//   6. round 5 operand b
//   7. round 5 operator
//   8. round 5 answer distractors (3, rejection sampled)
//   9. round 5 option order (shuffle)
//  10. round 5 answer deadline

import { rngFromString, randInt, shuffle } from './prng.js';
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

  // 4. Round 4: F1 start lights. The hold from all-five-lit to lights-out is the
  //    anti-cheat — seeded so it's identical for everyone but never countable.
  //    Never rendered or logged pre-round; only the resulting reaction is.
  const round4HoldMs = randInt(rng, 800, 2600);

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
    round4: { holdMs: round4HoldMs },
    round5: {
      a: opA, b: opB, op, answer,
      options,
      deadlineMs: round5DeadlineMs,
    },
  };
}
