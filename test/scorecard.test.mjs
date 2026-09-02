// Tests for the score card model and the Open Graph card.
//
// The point of these is that ONE model feeds three renderers. What they guard is
// that the card and the text block stay the same artifact, and that the OG image
// never depends on a glyph it cannot draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardModel, renderCardHTML, TONES, OG_SIZE, CARD_METRICS,
} from '../js/scorecard.js';
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
    assert.equal(row.tone, 'on');
  }
});

test('the card has exactly two tones, and neither is a failure state', () => {
  const worst = cardModel({ ...MOCKUP, rounds: MOCKUP.rounds.map((x) => r(x.key, 9)) });
  for (const row of worst.rows) assert.equal(row.tone, 'neutral');
  // Two, not four. A ramp of graded colours makes the card read as a status
  // dashboard; position already carries how far out a round was, so colour only
  // marks the good end. Anything added here is a second accent.
  assert.deepEqual(Object.keys(TONES).sort(), ['neutral', 'on']);
  assert.equal(TONES.on.color, '#27BF46', 'the accent, from tokens.css');
  assert.equal(TONES.neutral.color, '#FFFFFF', 'the figure colour, from tokens.css');
});

// --- Open Graph card -------------------------------------------------------

test('a round that ran off the scale is marked by position alone', () => {
  // `pegged` and "the dot sits at the end of the track" are the same predicate:
  // trackFraction clamps at exactly the threshold that sets pegged. A second
  // marker beside the dot restated it a third time, after the dot and the
  // printed value.
  const far = cardModel({ ...MOCKUP, rounds: MOCKUP.rounds.map((x) => r(x.key, 9)) });
  for (const row of far.rows) {
    assert.equal(row.pegged, true);
    assert.equal(row.fraction, 1, 'a pegged round sits at the extreme of the axis');
  }
  const html = renderCardHTML(far);
  assert.equal((html.match(/position:absolute/g) || []).length, far.rows.length + 1,
    'no extra mark is drawn for a pegged round');
});

test('the OG card draws every mark — it never emits a glyph it cannot render', () => {
  // Satori has only the font buffers the Worker hands it, so any of these in the
  // markup comes out BLANK. Every mark on the card is a drawn box instead.
  const html = renderCardHTML(cardModel(MOCKUP));
  for (const glyph of ['▸', '◂', '💎', '●', '◈']) {
    assert.ok(!html.includes(glyph), `OG card must not depend on the glyph ${glyph}`);
  }
  // A perfect round is an accent dot at dead centre, not a gem: emoji have no
  // place on a measurement instrument, and the axis says "exact" more precisely
  // than a picture can.
  const perfect = cardModel({ ...MOCKUP, rounds: MOCKUP.rounds.map((x) => r(x.key, 0, true)) });
  const phtml = renderCardHTML(perfect);
  assert.ok(!phtml.includes('<img'), 'no image marker remains on a perfect round');
  assert.equal((phtml.match(/#27BF46/g) || []).length, 5, 'five accent dots, one per round');
});

test('the value column is set as figures, not as chrome', () => {
  // css/styles.css tracks .cd-label and .cd-unit at --track-label and .cd-value
  // at --track-figure. The card once tracked its values out to the label's
  // 0.2em, which rendered "+ 0 . 0 4" and made the numeral column read as
  // decoration on the one surface strangers actually see.
  const html = renderCardHTML(cardModel(MOCKUP));
  const M = CARD_METRICS;
  const valueStyles = [...html.matchAll(/justify-content:flex-end;([^"]*)/g)].map((m) => m[1]);
  assert.equal(valueStyles.length, MOCKUP.rounds.length, 'one right-aligned value per round');
  for (const style of valueStyles) {
    assert.ok(style.includes(`letter-spacing:${M.FIGURE_EM}px`),
      `a value is tracked as chrome, not as a figure: ${style}`);
  }
  assert.ok(M.FIGURE_EM < M.TRACK_EM / 10, 'figures carry near-zero tracking');
});

test('the image and the screen agree on the values they print', () => {
  // The one thing that must never drift: what the card prints is what the
  // screen prints, character for character, U+2212 included.
  const model = cardModel(MOCKUP);
  const html = renderCardHTML(model);
  for (const row of model.rows) assert.ok(html.includes(row.value), `missing ${row.value}`);
  assert.ok(html.includes(model.totalSeconds.toFixed(2)), 'total printed to two places');
  assert.ok(html.includes('SECONDS OFF'), 'the same unit label the screen uses');
  assert.ok(!/-\d/.test(html.replace(/[a-z-]+:-?\d+px/g, '')),
    'negatives use U+2212, never an ASCII hyphen');
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

test('the card is laid out on the same 8px scale as the stylesheet', () => {
  // Every dimension the card emits has to be a step on the shared spacing scale,
  // or the image and the screen are only approximately the same object.
  const M = CARD_METRICS;
  assert.equal(M.PAD, 72, 'the page margin is the --page token');
  assert.equal(M.DOT % 4, 0, 'DOT is off the 4px base unit');
  // The columns derive from the frame rather than being typed in twice, so the
  // track cannot drift out of agreement with the margins.
  assert.equal(M.PLOT_W, M.W - 2 * M.PAD - M.TOTAL_W - 72);
  assert.equal(M.TRACK_W, M.PLOT_W - M.LABEL_W - M.VALUE_W - 64);
  assert.ok(M.TRACK_W > 4 * M.DOT, 'the dot must not swamp the axis');

  // The centre rule is the zero every dot is read against, so it has to cross
  // EVERY row — it once stopped one row short, which read as a rule belonging
  // to the first four rounds.
  const firstRowCentre = M.ROW_H / 2;
  const lastRowCentre = M.ROWS_H - M.ROW_H / 2;
  assert.ok(M.RULE_TOP < firstRowCentre - M.DOT / 2,
    'the rule starts above the first dot');
  assert.ok(M.RULE_TOP + M.RULE_H > lastRowCentre + M.DOT / 2,
    'the rule runs past the last dot');
  assert.equal(M.RULE_TOP + M.RULE_H - lastRowCentre, firstRowCentre - M.RULE_TOP,
    'the overhang is symmetric top and bottom');
});

test('the card centres its body structurally, not by a measured constant', () => {
  // The old artwork positioned the total by where the display face happened to
  // put its ink inside a 170px line box. That constant is the kind that goes
  // silently wrong the moment anything above it changes size.
  const html = renderCardHTML(cardModel(MOCKUP));
  assert.ok(html.includes('flex-grow:1;align-items:center'),
    'the body is centred by flexbox');
  // Anchored so `margin-top:` does not match: only a real `top:` on a text block.
  assert.ok(!/[;"]top:-?\d+px;font-family/.test(html),
    'no text block is positioned by a hand-measured vertical offset');
  // Absolute positioning survives only where a mark sits at a fraction of a
  // track: the dots, their pegs, and the centre rule.
  const model = cardModel(MOCKUP);
  const absolutes = (html.match(/position:absolute/g) || []).length;
  assert.equal(absolutes, model.rows.length + 1,
    'one dot per round and one centre rule — nothing else is absolutely placed');
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
