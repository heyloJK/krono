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

// Dot colour. There is deliberately NO red: SHARE sends this card, and a red
// failure state is exactly what the share must not carry. It isn't needed
// either — POSITION already encodes how far out a round was, so colour only has
// to mark the good end. The worst band gets a neutral, which reads as "far out"
// without reading as "you failed".
export const TONES = {
  perfect: { name: 'perfect', color: null },        // 💎, no dot
  green:   { name: 'green',   color: '#27BF46' },
  yellow:  { name: 'yellow',  color: '#F79B1B' },
  neutral: { name: 'neutral', color: 'rgba(255,255,255,0.82)' },
};

const TONE_FOR_BAND = {
  perfect: 'perfect', green: 'green', yellow: 'yellow', red: 'neutral',
};

export const PERFECT_GLYPH = '💎';

// Card artwork version. The OG image is served `immutable` with a one-year
// max-age — it has to be, since the URL is keyed only on the result and the
// image for a given result never changes on its own. That means a redesign
// would otherwise never reach anyone holding a cached copy, so every URL that
// points at a card carries this token. BUMP IT whenever the artwork changes.
export const CARD_VERSION = 6;

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

// ---- Open Graph card ------------------------------------------------------
// Rendered by the Worker at 1200×630 and rasterised. Kept to flexbox and
// absolute positioning only: the rasteriser (Satori) does not implement CSS
// grid, and every element with more than one child needs an explicit display.
//
// It also renders NO glyph it cannot guarantee. Satori has only the font
// buffers it is handed, so `▸` and `💎` come out blank — and a blank marker on
// a perfect round is the worst possible failure, since the best result in the
// game would silently disappear. Both are drawn instead: the gem as an inline
// SVG, the peg as a bar. Nothing here depends on a network fetch at render time.

const OG = {
  W: 1200, H: 630,
  PAD: 72,                 // left margin
  PAD_RIGHT: 104,          // deliberately wider than the left: the value column
                           // is right-aligned text, so it reads as sitting
                           // closer to the edge than a left-aligned column of
                           // the same measure does. The plot columns shift left
                           // with it rather than the track stretching to close
                           // the gap.
  LABEL_X: 440,
  TRACK_X: 600, TRACK_W: 340,
  VALUE_W: 96,
  ROWS: 5,
  ROW_H: 92,               // the rows are the card's rhythm; give them room
  CONTENT_TOP: 150,        // where the body starts. Explicit, NOT centred: the
                           // header is pinned at HEAD_Y, and a centred block
                           // ran its rule up level with the wordmark, which
                           // read as no gap at all under the title.
  BOTTOM_PAD: 67,          // ink to bottom edge
  DOT: 26, PEG_W: 4, PEG_H: 26, PEG_GAP: 7, GEM: 36,
  // Left column: header at the top, the total optically centred against the
  // plot (its glyphs land around y=310 to the rows' 315), tier as a footer
  // sitting level with the foot of the centre rule.
  HEAD_Y: 60,
};
// Derived, so the frame's margins can never drift out of agreement with the
// numbers above: the side margins from PAD/PAD_RIGHT, the row block centred in
// the frame however ROW_H is tuned, and the centre rule's tail sized so the ink
// stops exactly BOTTOM_PAD from the bottom edge. The header is NOT part of this
// — it stays pinned at HEAD_Y.
const ROW_SPAN = (OG.ROWS - 1) * OG.ROW_H;
OG.VALUE_X = OG.W - OG.PAD_RIGHT - OG.VALUE_W;
// The body occupies exactly CONTENT_TOP..(H − BOTTOM_PAD): both edges are stated
// rather than emergent, so neither can drift when ROW_H is tuned. The rows sit
// centred inside that span, and the rule's tails are whatever is left over.
OG.RULE_TOP = OG.CONTENT_TOP;
OG.RULE_BOTTOM = OG.H - OG.BOTTOM_PAD;
OG.ROW_TOP = OG.RULE_TOP + Math.round((OG.RULE_BOTTOM - OG.RULE_TOP - ROW_SPAN) / 2);
// The left column tracks the rows: the total's optical centre sits on the row
// block's centre, so the two halves of the card read as one line of sight.
// NUM_INK_CENTRE is where Squada One at 170px actually puts its glyph centre
// inside its line box — measured, not nominal.
const NUM_INK_CENTRE = 104;
OG.NUM_Y = OG.ROW_TOP + ROW_SPAN / 2 - NUM_INK_CENTRE;
OG.UNIT_Y = OG.NUM_Y + 196;

// A diamond, drawn. Percent-encoded rather than base64 so this stays pure string
// work and runs unchanged in the browser, in Node and in a Worker.
const GEM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">`
  + `<path fill="#5DADEC" d="M18 34 2 14h32z"/>`
  + `<path fill="#8CCAF7" d="M2 14 8 4h20l6 10z"/>`
  + `<path fill="#B9E2FB" d="M8 4l4 10h12L28 4z"/>`
  + `<path fill="#4A9BDB" d="M12 14h12l-6 20z"/></svg>`;
export const GEM_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(GEM_SVG)}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const box = (style) => `<div style="position:absolute;display:flex;${style}"></div>`;
const text = (style, body) => `<div style="position:absolute;display:flex;${style}">${body}</div>`;

function ogRow(row, i) {
  const y = OG.ROW_TOP + i * OG.ROW_H;
  const dotX = OG.TRACK_X + row.fraction * OG.TRACK_W;
  const colour = TONES[row.tone].color;

  const mark = row.isPerfect
    ? `<img src="${GEM_DATA_URI}" width="${OG.GEM}" height="${OG.GEM}" style="position:absolute;left:${dotX - OG.GEM / 2}px;top:${y - OG.GEM / 2}px" />`
    : box(`left:${dotX - OG.DOT / 2}px;top:${y - OG.DOT / 2}px;width:${OG.DOT}px;height:${OG.DOT}px;border-radius:${OG.DOT / 2}px;background:${colour}`)
      // Pegged: a hard stop at the end of the axis, in the row's own colour, so a
      // clipped value reads as clipped and not as a merely-large one.
      + (row.pegged
        ? box(`left:${(row.side === 'late'
            ? OG.TRACK_X + OG.TRACK_W + OG.DOT / 2 + OG.PEG_GAP
            : OG.TRACK_X - OG.DOT / 2 - OG.PEG_GAP - OG.PEG_W)}px;top:${y - OG.PEG_H / 2}px;width:${OG.PEG_W}px;height:${OG.PEG_H}px;background:${colour}`)
        : '');

  return text(`left:${OG.LABEL_X}px;top:${y - 10}px;font-size:19px;letter-spacing:3px;color:rgba(255,255,255,0.72)`, esc(row.label))
    + box(`left:${OG.TRACK_X}px;top:${y}px;width:${OG.TRACK_W}px;height:1px;background:rgba(255,255,255,0.28)`)
    + mark
    + text(`left:${OG.VALUE_X}px;top:${y - 12}px;width:${OG.VALUE_W}px;justify-content:flex-end;font-size:23px;letter-spacing:2px;color:#fff`, esc(row.value));
}

export function renderCardHTML(model) {
  const centreX = OG.TRACK_X + OG.TRACK_W / 2;
  const top = OG.RULE_TOP;
  const bottom = OG.RULE_BOTTOM;
  return `<div style="width:${OG.W}px;height:${OG.H}px;background:#0B0B12;color:#fff;position:relative;display:flex;font-family:Archivo">
    <div style="position:absolute;left:${OG.PAD}px;top:${OG.HEAD_Y}px;display:flex;align-items:center">
      <div style="display:flex;font-size:40px;font-weight:800;letter-spacing:8px">KRONO</div>
      <div style="display:flex;margin-left:10px;font-size:32px;font-weight:800;letter-spacing:6px;color:rgba(255,255,255,0.42)">#${esc(model.puzzleNumber)}</div>
    </div>
    ${text(`left:${OG.PAD}px;top:${OG.NUM_Y}px;font-family:'Squada One';font-size:170px;letter-spacing:2px`, model.totalSeconds.toFixed(2))}
    ${text(`left:${OG.PAD + 4}px;top:${OG.UNIT_Y}px;font-size:22px;font-weight:800;letter-spacing:6px;color:rgba(255,255,255,0.72)`, 'SECONDS OFF')}
    ${box(`left:${centreX}px;top:${top}px;width:1px;height:${bottom - top}px;background:rgba(255,255,255,0.5)`)}
    ${model.rows.map(ogRow).join('')}
  </div>`;
}

export const OG_SIZE = { width: OG.W, height: OG.H };
