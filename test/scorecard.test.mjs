// Tests for the score card model and the Open Graph card.
//
// The point of these is that ONE model feeds three renderers. What they guard is
// that the card and the text block stay the same artifact, and that the OG image
// never depends on a glyph it cannot draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardModel, renderCardHTML, TONES, OG_SIZE } from '../js/scorecard.js';
import {
  cellIndex, encodeResult, decodeResult, headlineRate, AXIS_HALF_RANGE_S,
} from '../js/share.js';

const r = (key, signedErrorSeconds, isPerfect = false) => ({ key, signedErrorSeconds, isPerfect });

// The day from the mockup: +0.04, perfect, +0.06, +0.67, −0.26 → 1.03 total.
const MOCKUP = {
  puzzleNumber: 28,
  tier: 'CHRONOMETER',
  rounds: [r('MARK', 0.04), r('FRAC', 0, true), r('READ', 0.06), r('DRFT', 0.67), r('SPLT', -0.26)],
};

// --- Model -----------------------------------------------------------------

test('reproduces the mockup', () => {
  const m = cardModel(MOCKUP);
  assert.equal(m.totalSeconds, 1.03);
  assert.deepEqual(m.rows.map((x) => x.label),
    ['ROUND 1', 'ROUND 2', 'ROUND 3', 'ROUND 4', 'ROUND 5']);
  assert.deepEqual(m.rows.map((x) => x.value),
    ['+0.04', '0.00', '+0.06', '+0.67', '−0.26']);
});

test('the headline is the sum of the column beside it', () => {
  const m = cardModel(MOCKUP);
  const summed = m.rows.reduce((s, x) => s + Math.abs(x.seconds), 0);
  assert.equal(Math.round(summed * 100) / 100, m.totalSeconds);
  assert.equal(m.totalSeconds, headlineRate(MOCKUP.rounds));
});

test('each row keeps the text block cell it would occupy', () => {
  for (const row of cardModel(MOCKUP).rows) {
    assert.equal(row.index, row.isPerfect ? 7 : cellIndex(row.seconds));
  }
});

test('placement is continuous, so near-equal rounds do not collide', () => {
  const m = cardModel(MOCKUP);
  // +0.04 and +0.06 share a text cell but must not share a pixel on the card.
  assert.equal(m.rows[0].index, m.rows[2].index);
  assert.notEqual(m.rows[0].fraction, m.rows[2].fraction);
});

test('the scale is fixed: 0 is centre, ±half-range are the ends', () => {
  const m = cardModel({
    ...MOCKUP,
    rounds: [r('MARK', 0), r('FRAC', -AXIS_HALF_RANGE_S), r('READ', AXIS_HALF_RANGE_S),
      r('DRFT', -9), r('SPLT', 9)],
  });
  assert.deepEqual(m.rows.map((x) => x.fraction), [0.5, 0, 1, 0, 1]);
  assert.deepEqual(m.rows.map((x) => x.pegged), [false, true, true, true, true]);
  assert.deepEqual(m.rows.map((x) => x.side), [null, 'early', 'late', 'early', 'late']);
});

test('perfect sits at centre and is never pegged', () => {
  const m = cardModel({ ...MOCKUP, rounds: MOCKUP.rounds.map((x) => r(x.key, 9, true)) });
  for (const row of m.rows) {
    assert.equal(row.fraction, 0.5);
    assert.equal(row.pegged, false);
    assert.equal(row.tone, 'perfect');
  }
});

test('no tone is red — the card is shared, and §13 forbids a failure state', () => {
  const worst = cardModel({ ...MOCKUP, rounds: MOCKUP.rounds.map((x) => r(x.key, 9)) });
  for (const row of worst.rows) assert.equal(row.tone, 'neutral');
  for (const tone of Object.values(TONES)) {
    if (!tone.color) continue;
    assert.ok(!/^#(f|e)[0-9a-f]{2}[0-3]/i.test(tone.color) || tone.color === '#F79B1B',
      `${tone.name} reads as a red failure state`);
  }
});
test('the OG card draws every mark — it never emits a glyph it cannot render', () => {
  // Satori has only the font buffers the Worker hands it. A ▸ or a 💎 in the
  // markup comes out BLANK, which on a perfect round would silently erase the
  // best result in the game. Both are drawn instead.
  const html = renderCardHTML(cardModel(MOCKUP));
  for (const glyph of ['▸', '◂', '💎', '●', '◈']) {
    assert.ok(!html.includes(glyph), `OG card must not depend on the glyph ${glyph}`);
  }
  assert.ok(html.includes('<img src="data:image/svg+xml'), 'perfect round needs its drawn gem');
});

test('the card carries no tier tag and no URL stamp', () => {
  const html = renderCardHTML(cardModel(MOCKUP));
  assert.ok(!html.includes(MOCKUP.tier), 'the tier tag was removed from the artwork');
  // Ignore the gem's data URI, which legitimately carries a percent-encoded
  // xmlns, and look for a real host or scheme in the artwork itself.
  const artwork = html.replace(/data:image[^"]*/g, '');
  assert.ok(!/:\/\/|localhost|\d+\.\d+\.\d+\.\d+|\.(app|com|dev|io|xyz)\b/i.test(artwork),
    'no URL is stamped into the card');
  assert.equal(renderCardHTML.length, 1, 'no options argument remains that could stamp one');
});

test('the OG card is Satori-safe: every element declares a display', () => {
  const html = renderCardHTML(cardModel(MOCKUP));
  const divs = html.match(/<div style="[^"]*"/g) || [];
  for (const d of divs) {
    assert.ok(d.includes('display:flex'), `Satori needs an explicit display: ${d.slice(0, 70)}`);
  }
});

test('the body spans exactly CONTENT_TOP to BOTTOM_PAD', () => {
  // Both edges are stated, not emergent. The header is pinned at HEAD_Y on its
  // own, so nothing else holds the frame: a centred block used to run its rule
  // up level with the wordmark, which read as no gap under the title at all.
  const html = renderCardHTML(cardModel(MOCKUP));
  const rule = /top:(\d+)px;width:1px;height:(\d+)px/.exec(html);
  assert.ok(rule, 'centre rule not found');
  const top = Number(rule[1]);
  assert.equal(top, 150, 'the body starts below the header, not level with it');
  assert.equal(OG_SIZE.height - (top + Number(rule[2])), 67, 'bottom padding');
});
test('the OG card renders at the declared size', () => {
  assert.deepEqual(OG_SIZE, { width: 1200, height: 630 });
  assert.ok(renderCardHTML(cardModel(MOCKUP)).includes('width:1200px;height:630px'));
});

// --- URL codec -------------------------------------------------------------

test('a day round-trips through the share link', () => {
  const code = encodeResult(MOCKUP);
  assert.equal(code, '28.4.0p.6.67.-26.C');
  assert.deepEqual(decodeResult(code), {
    puzzleNumber: 28, tier: 'CHRONOMETER', rounds: MOCKUP.rounds,
  });
});

test('the decoded day renders the identical card', () => {
  const code = encodeResult(MOCKUP);
  assert.equal(renderCardHTML(cardModel(decodeResult(code))),
    renderCardHTML(cardModel(MOCKUP)));
});

test('every tier survives the round trip', () => {
  for (const tier of ['REGULATED', 'CHRONOMETER', 'MASTER CHRONOMETER', 'OBSERVATORY']) {
    assert.equal(decodeResult(encodeResult({ ...MOCKUP, tier })).tier, tier);
  }
});

test('a malformed code decodes to null, never a throw', () => {
  const bad = ['', 'garbage', '28', '28.1.2.3.4.5', '28.1.2.3.4.5.Z', '28.1.2.3.4.x.C',
    'a.1.2.3.4.5.C', '28.1.2.3.4.5.C.C', '-1.1.2.3.4.5.C', '28.1.2.3.4.5555555.C',
    null, undefined, 42, '28.1.2.3.4.5.C/../../etc'];
  for (const code of bad) assert.equal(decodeResult(code), null, `should reject ${String(code)}`);
});

test('the link carries signed error and nothing else', () => {
  // Spoiler safety: no target durations, no marked times, and never Round 4's
  // tick bias. The only numbers in a code are the puzzle and the five errors.
  const decoded = decodeResult(encodeResult(MOCKUP));
  assert.deepEqual(Object.keys(decoded).sort(), ['puzzleNumber', 'rounds', 'tier'].sort());
  for (const round of decoded.rounds) {
    assert.deepEqual(Object.keys(round).sort(),
      ['isPerfect', 'key', 'signedErrorSeconds'].sort());
  }
});
