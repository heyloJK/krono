// scorecard.js — the score card, as data.
//
// PURE: no DOM, no clock, no network. One model feeds THREE renderers — the
// in-app screen (CSS grid, js/app.js), the Open Graph image (flex/absolute HTML,
// renderCardHTML below, rasterised in the Worker) and the text shot group
// (js/share.js). They must never drift, so none of them re-derives placement:
// every one of them reads cellIndex() from js/share.js.

import {
  cellIndex, formatSigned, headlineRate, round2, AXIS_CENTRE_IDX,
  AXIS_HALF_RANGE_S,
} from './share.js';
import { bandForErrorMs } from './scoring.js';

// Dot colour. TWO tones, not four.
//
// SHARE sends this card, so it never carried a red failure state, and it never
// needed one: POSITION already encodes how far out a round was, so colour only
// has to mark the good end. That argument was already written here — it just
// stopped one colour short. Yellow was a second accent doing the same job as
// green less clearly, and a four-tone ramp made the card read as a status
// dashboard. One accent marks the rounds that landed; everything else is the
// figure colour and is read by where it sits.
export const TONES = {
  on:      { name: 'on',      color: '#27BF46' },   // --accent
  neutral: { name: 'neutral', color: '#FFFFFF' },   // --figure
};

// perfect and green both mean "landed"; yellow and red both mean "read the
// position". The band names themselves are scoring, and are untouched.
const TONE_FOR_BAND = {
  perfect: 'on', green: 'on', yellow: 'neutral', red: 'neutral',
};

// Card artwork version. The OG image is served `immutable` with a one-year
// max-age — it has to be, since the URL is keyed only on the result and the
// image for a given result never changes on its own. That means a redesign
// would otherwise never reach anyone holding a cached copy, so every URL that
// points at a card carries this token. BUMP IT whenever the artwork changes.
export const CARD_VERSION = 7;

// A row's dot as a fraction of the axis track, 0 (fully early) to 1 (fully late).
//
// CONTINUOUS, not snapped to the 15 text cells. The text block quantises because
// monospace forces it to; a drawn axis has no such limit, and snapping would put
// two rounds 0.02s apart on the identical pixel, which reads as a bug. Same
// fixed scale, same clamp, same half-range — only the resolution differs, and
// the printed values are identical either way.
export function trackFraction(seconds) {
  const clamped = Math.max(-1, Math.min(1, seconds / AXIS_HALF_RANGE_S));
  return (clamped + 1) / 2;
}

// shareInput (see buildShareInput in js/app.js) → everything a renderer needs.
export function cardModel(input) {
  const rows = input.rounds.map((r, i) => {
    const e = round2(r.signedErrorSeconds);
    const isPerfect = !!r.isPerfect;
    const pegged = !isPerfect && Math.abs(e) >= AXIS_HALF_RANGE_S;
    const index = isPerfect ? AXIS_CENTRE_IDX : cellIndex(e);
    const band = isPerfect ? 'perfect' : bandForErrorMs(Math.abs(e) * 1000).name;
    return {
      label: `ROUND ${i + 1}`,
      key: r.key,
      seconds: e,
      value: formatSigned(e),
      isPerfect,
      pegged,
      side: pegged ? (e < 0 ? 'early' : 'late') : null,
      index,                                        // the text block's cell, for correspondence
      fraction: isPerfect ? 0.5 : trackFraction(e), // where the card draws it
      tone: TONE_FOR_BAND[band] || 'neutral',
    };
  });
  return {
    puzzleNumber: input.puzzleNumber,
    // The RECONCILED total — the sum of the values in the column beside it, so a
    // player who adds them up lands on the number they are shown.
    totalSeconds: headlineRate(input.rounds),
    tier: input.tier,
    rows,
  };
}

// ---- The shared image -----------------------------------------------------
// Rendered by the Worker at 1200x630 and rasterised. Satori does not implement
// CSS grid, so the frame is flexbox with absolute positioning only where a mark
// has to sit at a fraction of a track.
//
// THIS AND THE RESULTS SCREEN ARE ONE OBJECT. Everything below mirrors
// css/styles.css: header top-left, total left-aligned, plot right, the same
// label / track / value columns, one centre rule, two dot tones, the same
// tabular values with U+2212 for negatives. They used to disagree about the two
// most visible things on the card — the screen centred its header and total,
// the image left-aligned both — which is what made the thing you look at and
// the thing you post read as two designs of one dataset.
//
// The vertical centring is STRUCTURAL (`align-items: center`), not a measured
// constant. It used to be an offset derived from where the display face happened
// to put its ink inside a 170px line box, which is exactly the kind of number
// that silently goes wrong the moment anything above it changes size.
//
// Sizes come off the same 8px scale the stylesheet uses, so a value here reads
// straight across to a token there. Column widths are measured against the
// longest string each column can hold, not guessed.

const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 72 };

const OG = {
  W: 1200, H: 630,
  PAD: S[8],                 // --page, all four sides
  HEAD_SIZE: 24,             // --t-label at card scale
  LABEL_SIZE: 24,
  NUM_SIZE: 160,             // the hero grade
  TRACK_EM: 4.8,             // 0.2em of LABEL_SIZE — --track-label
  TOTAL_W: 340,              // fits "24.50" at NUM_SIZE (295px) and the unit
  LABEL_W: 152,              // fits "ROUND 1" tracked out (146px)
  VALUE_W: 100,              // fits "-10.00" tabular (right-aligned)
  ROW_H: 80,
  ROWS: 5,
  DOT: S[5],
};

// Derived. The plot fills whatever the total column leaves, and the track fills
// whatever the label and value columns leave — the same relationship the
// stylesheet expresses as `minmax(0, 1fr)`.
OG.PLOT_W = OG.W - 2 * OG.PAD - OG.TOTAL_W - S[8];
OG.TRACK_W = OG.PLOT_W - OG.LABEL_W - OG.VALUE_W - 2 * S[6];
OG.ROWS_H = OG.ROWS * OG.ROW_H;
// The centre rule crosses every row and overhangs the outer two by --s5 past
// the dot, as `.cd-centre` does on screen.
OG.RULE_X = OG.LABEL_W + S[6] + OG.TRACK_W / 2;
// Measured from the top of the row block: the first row's centre sits at
// ROW_H/2, and the rule starts --s5 above that row's dot. The bottom overhang
// mirrors it, so the rule's height is the block minus both insets.
OG.RULE_TOP = OG.ROW_H / 2 - OG.DOT / 2 - S[5];
OG.RULE_H = OG.ROWS_H - 2 * OG.RULE_TOP;

// The palette, as literals, because a Worker has no stylesheet. These are the
// only place tokens.css values are repeated, and they are the ones the card
// uses: --surface, --figure, --figure-dim, --rule.
const C = {
  surface: '#0B0B12',
  figure: '#FFFFFF',
  dim: 'rgba(255,255,255,0.72)',
  rule: 'rgba(255,255,255,0.28)',
  ruleStrong: 'rgba(255,255,255,0.5)',
};

// The two type grades, matching the screen: condensed heavy for figures,
// normal-width heavy for tracked chrome. See worker/index.js for the buffers.
const FIGURE_FACE = "'Archivo Figure'";
const LABEL_FACE = "'Archivo'";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const div = (style, body = '') => `<div style="display:flex;${style}">${body}</div>`;
const abs = (style, body = '') => div(`position:absolute;${style}`, body);

// Tracked uppercase, the card's only chrome style.
const chrome = (extra = '') =>
  `font-family:${LABEL_FACE};font-size:${OG.LABEL_SIZE}px;letter-spacing:${OG.TRACK_EM}px;${extra}`;

function ogRow(row) {
  const colour = TONES[row.tone].color;
  const dotX = row.fraction * OG.TRACK_W;

  // One mark per row. A round that ran off the scale keeps its dot at the end
  // of the track, which is the same predicate `pegged` tests — no second marker
  // is drawn for it, here or on screen.
  const track = div(
    `position:relative;width:${OG.TRACK_W}px;height:1px;background:${C.rule};`
    + `margin:0 ${S[6]}px`,
    abs(`left:${dotX - OG.DOT / 2}px;top:${-OG.DOT / 2}px;width:${OG.DOT}px;`
      + `height:${OG.DOT}px;border-radius:${OG.DOT / 2}px;background:${colour}`),
  );

  return div(
    `height:${OG.ROW_H}px;align-items:center`,
    div(`width:${OG.LABEL_W}px;${chrome(`color:${C.dim}`)}`, esc(row.label))
    + track
    + div(`width:${OG.VALUE_W}px;justify-content:flex-end;${chrome(`color:${C.figure}`)}`,
      esc(row.value)),
  );
}

export function renderCardHTML(model) {
  const header = div(chrome(), `<div style="display:flex">KRONO</div>`
    + `<div style="display:flex;margin-left:${S[3]}px;color:${C.dim}">#${esc(model.puzzleNumber)}</div>`);

  const total = div(
    `flex-direction:column;width:${OG.TOTAL_W}px`,
    div(`font-family:${FIGURE_FACE};font-size:${OG.NUM_SIZE}px;line-height:1;letter-spacing:2px`,
      model.totalSeconds.toFixed(2))
    + div(`margin-top:${S[5]}px;${chrome(`color:${C.dim}`)}`, 'SECONDS OFF'),
  );

  const plot = div(
    `position:relative;flex-direction:column;margin-left:${S[8]}px;width:${OG.PLOT_W}px`,
    abs(`left:${OG.RULE_X}px;top:${OG.RULE_TOP}px;width:1px;height:${OG.RULE_H}px;`
      + `background:${C.ruleStrong}`)
    + model.rows.map(ogRow).join(''),
  );

  // Header, body, and a footer slot the same height as the header — the
  // `chrome / 1fr / chrome` rhythm the results screen uses. Reserving the
  // footer is what keeps the body optically centred in the frame rather than
  // sitting low under the title.
  return `<div style="width:${OG.W}px;height:${OG.H}px;background:${C.surface};`
    + `color:${C.figure};display:flex;flex-direction:column;padding:${OG.PAD}px;`
    + `font-family:${LABEL_FACE}">`
    + header
    + div(`flex-grow:1;align-items:center`, total + plot)
    + div(`height:${OG.HEAD_SIZE}px`)
    + `</div>`;
}

export const OG_SIZE = { width: OG.W, height: OG.H };
export const CARD_COLORS = C;
export const CARD_METRICS = OG;
