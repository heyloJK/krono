// Golden tests for the shot group. Run: node --test test/
//
// These lock the FORMAT, not just the code. If a change here is deliberate the
// golden strings move with it; if one moves by accident the block has silently
// stopped being byte-identical across players, which is the one property the
// whole format depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderShare, renderMonthly, shareSummary, shareForPlatform,
  cellIndex, headlineRate, biasWord, consistencyWord, formatSigned,
  AXIS_WIDTH, BLOCK_WIDTH,
} from '../js/share.js';

const r = (key, signedErrorSeconds, isPerfect = false) => ({ key, signedErrorSeconds, isPerfect });

// The reference day from the spec.
const GOLDEN = {
  puzzleNumber: 2122,
  tier: 'CHRONOMETER',
  rounds: [
    r('MARK', +0.42), r('FRAC', -0.04), r('READ', +0.19),
    r('DRFT', -0.11), r('SPLT', +0.05),
  ],
};

// --- Derivations, verified independently of the renderer -------------------

test('cell indices match the hand-derived values', () => {
  assert.equal(cellIndex(+0.42), 13); // 0.42/0.50 × 7 = 5.88 → +6
  assert.equal(cellIndex(-0.04), 6);  // −0.08 × 7 = −0.56 → −1
  assert.equal(cellIndex(+0.19), 10); // +3
  assert.equal(cellIndex(-0.11), 5);  // −2
  assert.equal(cellIndex(+0.05), 8);  // +1
});

test('half-way cells round away from zero, symmetrically', () => {
  // ±0.5/7 of the half-range lands exactly on .5 — early and late must move the
  // same distance, or the axis is biased about its own centre.
  const e = (0.5 / 7) * 0.50;
  assert.equal(cellIndex(+e) - 7, 1);
  assert.equal(cellIndex(-e) - 7, -1);
});

test('headline is the sum of the ABSOLUTE rounded figures', () => {
  assert.equal(headlineRate(GOLDEN.rounds), 0.81); // 0.42+0.04+0.19+0.11+0.05
});

test('signature words come out of the same rounded figures', () => {
  assert.equal(biasWord(GOLDEN.rounds), 'PATIENT');        // mean +0.102 > 0.08
  assert.equal(consistencyWord(GOLDEN.rounds), 'DRIFTING'); // pop. SD 0.188 >= 0.15
});

test('negatives use U+2212, and zero carries no sign', () => {
  assert.equal(formatSigned(-0.04), '−0.04');
  assert.ok(!formatSigned(-0.04).includes('-'), 'ASCII hyphen skews the value column');
  assert.equal(formatSigned(0), '0.00');
  assert.equal(formatSigned(-0.0004), '0.00'); // rounds to −0, still unsigned
});

// --- Golden A: standard ----------------------------------------------------

const GOLDEN_A = [
  'KRONO #2122          0.81 s/day',
  'MARK   ·············●·    +0.42',
  'FRAC   ······●········    −0.04',
  'READ   ··········●····    +0.19',
  'DRFT   ·····●·········    −0.11',
  'SPLT   ········●······    +0.05',
  'early  ───────┴───────     late',
  'PATIENT / DRIFTING · CHRONOMETER',
].join('\n');

test('golden A — standard day', () => {
  assert.equal(renderShare(GOLDEN), GOLDEN_A);
});

test('every row sits on the 31-column grid', () => {
  for (const line of renderShare(GOLDEN).split('\n')) {
    assert.ok(line.length <= BLOCK_WIDTH + 1,
      `line exceeds the grid and will wrap on a phone: ${JSON.stringify(line)}`);
  }
});

test('the axis is exactly AXIS_WIDTH cells on every row', () => {
  for (const line of renderShare(GOLDEN).split('\n').slice(1, 6)) {
    assert.equal(line.slice(7, 7 + AXIS_WIDTH).length, AXIS_WIDTH);
    assert.equal((line.match(/[·●◈◂▸]/g) || []).length, AXIS_WIDTH);
  }
});

// --- Golden B: all pegged --------------------------------------------------

const PEGGED = {
  puzzleNumber: 2123,
  tier: 'REGULATED',
  rounds: [
    r('MARK', +0.9), r('FRAC', -0.9), r('READ', +0.9),
    r('DRFT', -0.9), r('SPLT', +0.9),
  ],
};

test('golden B — an all-pegged day is honest about clipping', () => {
  assert.equal(renderShare(PEGGED), [
    'KRONO #2123          4.50 s/day',
    'MARK   ··············▸    +0.90',
    'FRAC   ◂··············    −0.90',
    'READ   ··············▸    +0.90',
    'DRFT   ◂··············    −0.90',
    'SPLT   ··············▸    +0.90',
    'early  ───────┴───────     late',
    'PATIENT / DRIFTING · REGULATED',
  ].join('\n'));
});

test('the scale is fixed, not normalised to the day', () => {
  // A wild day and a tight day must NOT render identically. Per-day
  // normalisation is the one change that would silently destroy the format.
  const tight = { ...PEGGED, rounds: PEGGED.rounds.map((x) => r(x.key, x.signedErrorSeconds / 90)) };
  assert.notEqual(renderShare(PEGGED), renderShare(tight));
});

// --- Golden C: two perfect rounds -----------------------------------------

const MARKED = {
  puzzleNumber: 2124,
  tier: 'MASTER CHRONOMETER',
  rounds: [
    r('MARK', 0, true), r('FRAC', -0.04), r('READ', 0, true),
    r('DRFT', -0.11), r('SPLT', +0.05),
  ],
};

test('golden C — perfect rounds carry ◈ at centre, and nothing else changes', () => {
  const out = renderShare(MARKED).split('\n');
  assert.equal(out[1], 'MARK   ·······◈·······     0.00');
  assert.equal(out[3], 'READ   ·······◈·······     0.00');
  assert.ok(!out[2].includes('◈'), 'a non-perfect row must not carry the glyph');
  assert.ok(!out[4].includes('◈'));
  assert.equal(out.length, 8, 'B adds no lines over A — the glyph does the talking');
});

// --- Escalation ------------------------------------------------------------

test('flawless drops the numerals entirely', () => {
  const flawless = {
    puzzleNumber: 2122, tier: 'OBSERVATORY', globalRank: 1,
    rounds: ['MARK', 'FRAC', 'READ', 'DRFT', 'SPLT'].map((k) => r(k, 0, true)),
  };
  assert.equal(renderShare(flawless), [
    '◈ KRONO #2122 ◈',
    '◈ ◈ ◈ ◈ ◈',
    'OBSERVATORY · #1 GLOBAL',
  ].join('\n'));
});

test('global rank appears only in the flawless variant', () => {
  assert.ok(!renderShare({ ...GOLDEN, globalRank: 4 }).includes('GLOBAL'));
});

test('a streak under 5 renders nothing; 5 or more appends one line', () => {
  assert.equal(renderShare({ ...GOLDEN, streak: 4 }), GOLDEN_A);
  assert.equal(renderShare({ ...GOLDEN, streak: 5 }), GOLDEN_A + '\n🔥 5');
});

// --- Compact ---------------------------------------------------------------

test('compact maps through the same cellIndex maths', () => {
  assert.equal(renderShare(GOLDEN, 'compact'), 'KRONO #2122 ⇝ · › ‹ · 0.81 s/day');
});

test('a flawless day compacts to the quietest glyphs', () => {
  const flawless = {
    puzzleNumber: 9, tier: 'OBSERVATORY',
    rounds: ROUND_KEYS_FIXTURE.map((k) => r(k, 0, true)),
  };
  assert.ok(renderShare(flawless, 'compact').includes('· · · · ·'));
});

// --- Monthly ---------------------------------------------------------------

test('monthly grades by tier and leaves unplayed days blank', () => {
  const days = [
    { tier: 'CHRONOMETER' }, { tier: 'REGULATED' }, null,
    { tier: 'MASTER CHRONOMETER' }, { tier: 'OBSERVATORY' },
    { tier: 'OBSERVATORY', isFlawless: true },
  ];
  assert.equal(renderMonthly({ label: 'AUGUST', days }), 'KRONO · AUGUST\n▪▫ ◆◈✦');
});

test('an unplayed day is a gap, never a worst-case glyph', () => {
  const out = renderMonthly({ label: 'AUGUST', days: [null, null] });
  assert.equal(out.split('\n')[1], '  ');
});

// --- Spoiler safety & accessibility ----------------------------------------

test('no round has a red failure state anywhere in the block', () => {
  for (const v of ['default', 'compact']) {
    assert.ok(!renderShare(PEGGED, v).includes('🟥'));
  }
});

test('the card\'s summary announces only what the card shows', () => {
  // No bias/consistency/tier: the score card carries none of them, and a screen
  // reader hearing a verdict that is not on screen is worse than a shorter line.
  assert.equal(shareSummary(GOLDEN, { rateNoun: 'seconds off', includeVerdict: false }),
    'Krono 2122. Rate 0.81 seconds off. Mark 0.42 late, Fraction 0.04 early, ' +
    'Readout 0.19 late, Drift 0.11 early, Split 0.05 late.');
});

test('summary reads as prose for a screen reader', () => {
  assert.equal(shareSummary(GOLDEN),
    'Krono 2122. Rate 0.81 seconds per day. Mark 0.42 late, Fraction 0.04 early, ' +
    'Readout 0.19 late, Drift 0.11 early, Split 0.05 late. Patient, drifting. Chronometer.');
});

// --- Platform routing ------------------------------------------------------

test('monospace surfaces get a fence, image surfaces are flagged, X gets compact', () => {
  assert.equal(shareForPlatform(GOLDEN, 'slack').text, '```\n' + GOLDEN_A + '\n```');
  assert.equal(shareForPlatform(GOLDEN, 'clipboard').text, GOLDEN_A);
  assert.equal(shareForPlatform(GOLDEN, 'imessage').path, 'image');
  assert.equal(shareForPlatform(GOLDEN, 'x').variant, 'compact');
});

const ROUND_KEYS_FIXTURE = ['MARK', 'FRAC', 'READ', 'DRFT', 'SPLT'];
