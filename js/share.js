// share.js — the shot group. Builds the shareable block that carries the day.
//
// PURE module: no clock, no locale lookup, no network, no DOM. The same input
// must produce a byte-identical string on every platform, or the block stops
// being a shared artifact. Numbers go through Number.prototype.toFixed, which
// is locale-invariant by specification (always "." as the decimal separator) —
// never toLocaleString, which would render "0,81" in half the world.
//
// WHY THIS FORMAT. Squares discard sign and magnitude, which is all this game
// actually produces; a bare seconds figure means nothing to someone who does
// not play. The shot group plots signed error per round on a shared axis, so a
// tight cluster and a wide scatter are told apart PRE-VERBALLY by a stranger.
// That property is the entire point, and every constant below protects it.
//
// SPOILER SAFETY. Signed error is independent of target duration, so this block
// leaks nothing by construction. Keep it that way: no target durations, no
// marked times, and never Round 4's tick bias — the in-app "Reference ran 22%
// fast" line is the one genuine spoiler in the game and must not reach here.

// ---- Config --------------------------------------------------------------

export const AXIS_WIDTH = 15;                       // must stay ODD
export const AXIS_CENTRE_IDX = (AXIS_WIDTH - 1) / 2; // 7
// The half-range the axis spans, in seconds. Tune to roughly the 90th
// percentile of per-round absolute error once there is real data, so ~10% of
// dots peg. THE SCALE IS FIXED, NEVER ADAPTIVE: normalising to the day's own
// error range makes an excellent day and a terrible day render identically,
// which destroys the only property that makes this format work. A bad day
// SHOULD look pegged at the edges — that is information, not a bug.
export const AXIS_HALF_RANGE_S = 0.50;

export const BIAS_T = 0.08;      // |mean signed error| below this reads as TRUE
export const CONSIST_T = 0.15;   // population SD below this reads as STEADY
export const STREAK_MIN = 5;     // below this the streak line is omitted entirely

export const BLOCK_WIDTH = 31;   // total columns; keep <= 32 so phones don't wrap

// Column grid. Widening the axis to gain resolution wraps the block on a phone,
// and a wrapped shot group is unreadable.
const COL_LABEL = 4;   // cols 0–3
const COL_GAP = 3;     // cols 4–6 and 22–24
const COL_VALUE = 6;   // cols 25–30

const DOT = '·';
const MARKER = '●';
const MARKER_PERFECT = '◈';
const MARKER_PEG_EARLY = '◂';
const MARKER_PEG_LATE = '▸';

export const ROUND_KEYS = ['MARK', 'FRAC', 'READ', 'DRFT', 'SPLT'];
// Long names for the screen-reader summary (and the image alt text).
const ROUND_LONG = {
  MARK: 'Mark', FRAC: 'Fraction', READ: 'Readout', DRFT: 'Drift', SPLT: 'Split',
};

// Rarity ladder for the monthly strip, lowest to highest. Four tiers plus the
// flawless day, which has no tier above it.
export const HALLMARK = {
  'REGULATED': '▫',
  'CHRONOMETER': '▪',
  'MASTER CHRONOMETER': '◆',
  'OBSERVATORY': '◈',
  'FLAWLESS': '✦',
};
const HALLMARK_MISSED = ' '; // a gap is neutral; a black mark for not playing is punitive

// Seven graded characters for the compact variant, early → late.
const COMPACT_GLYPHS = ['⇜', '←', '‹', '·', '›', '→', '⇝'];

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// ---- Number handling -----------------------------------------------------

// Round half AWAY FROM ZERO, so −0.5 → −1 and +0.5 → +1. Math.round alone rounds
// half UP, which is asymmetric across the axis centre and would bias every
// early round one cell towards late.
function roundHalfAway(x) {
  return (x < 0 ? -1 : 1) * Math.round(Math.abs(x));
}

// To 2dp, half away from zero. The toFixed(6) pass first is not decoration:
// 0.145 * 100 is 14.499999999999998 in binary floating point, which would round
// DOWN and put the displayed value one cent off the value people can add up.
export function round2(x) {
  const sign = x < 0 ? -1 : 1;
  const scaled = Number((Math.abs(x) * 100).toFixed(6));
  return sign * Math.round(scaled) / 100;
}

// Always an explicit sign, U+2212 MINUS SIGN for negatives. NOT an ASCII hyphen:
// a hyphen is narrower in most monospace faces than the plus it pairs with, and
// the value column stops lining up. Exactly zero carries no sign at all.
export function formatSigned(v) {
  const r = round2(v);
  if (r === 0) return '0.00';                  // covers −0 too
  return (r < 0 ? '−' : '+') + Math.abs(r).toFixed(2);
}

// ---- Axis ----------------------------------------------------------------

// Signed error in seconds → 0-based cell on the axis. Clamped, so a value past
// the half-range lands on the edge cell rather than off the row.
export function cellIndex(errorSeconds) {
  const clamped = Math.max(-1, Math.min(1, errorSeconds / AXIS_HALF_RANGE_S));
  return AXIS_CENTRE_IDX + roundHalfAway(clamped * AXIS_CENTRE_IDX);
}

// One axis row. Perfect wins over pegged (a perfect round cannot be pegged).
// Pegged rounds draw an arrowhead rather than a dot: being honest about
// clipping costs one character and stops a pegged dot reading as a merely-large
// one.
export function axisRow(errorSeconds, isPerfect = false) {
  const cells = new Array(AXIS_WIDTH).fill(DOT);
  if (isPerfect) {
    cells[AXIS_CENTRE_IDX] = MARKER_PERFECT;
  } else if (Math.abs(errorSeconds) >= AXIS_HALF_RANGE_S) {
    const late = errorSeconds > 0;
    cells[late ? AXIS_WIDTH - 1 : 0] = late ? MARKER_PEG_LATE : MARKER_PEG_EARLY;
  } else {
    cells[cellIndex(errorSeconds)] = MARKER;
  }
  return cells.join('');
}

// ---- Layout --------------------------------------------------------------

const padRight = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const padLeft = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s;

// "early" at col 0, the rule sitting exactly under the axis columns with its
// pivot on the centre cell, "late" right-aligned to the last column.
function axisLegend() {
  const rule = '─'.repeat(AXIS_CENTRE_IDX) + '┴' + '─'.repeat(AXIS_CENTRE_IDX);
  const head = padRight('early', COL_LABEL + COL_GAP);
  return head + rule + padLeft('late', BLOCK_WIDTH - head.length - rule.length);
}

function headerLine(puzzleNumber, headline) {
  const left = `KRONO #${puzzleNumber}`;
  const right = `${headline.toFixed(2)} s/day`;
  return padRight(left, Math.max(left.length + 1, BLOCK_WIDTH - right.length)) + right;
}

// ---- Derived statistics --------------------------------------------------

// Everything downstream reads the ROUNDED value, so the dot, the number, the
// headline and the signature can never disagree with each other.
function normalise(rounds) {
  return rounds.map((r) => ({
    key: r.key,
    e: round2(r.signedErrorSeconds),
    isPerfect: !!r.isPerfect,
  }));
}

// Sum of the ABSOLUTE values of the rounded per-round figures. People will add
// the column; if it does not reconcile the block looks broken and the format
// loses credibility. This can differ from the internally stored score by up to
// ~0.025s — that is accepted. The stored score stays authoritative for
// leaderboards and tiers; do NOT "fix" this by printing the unrounded total.
export function headlineRate(rounds) {
  return round2(normalise(rounds).reduce((sum, r) => sum + Math.abs(r.e), 0));
}

export function biasWord(rounds) {
  const rs = normalise(rounds);
  const mean = rs.reduce((s, r) => s + r.e, 0) / rs.length;
  if (mean < -BIAS_T) return 'EAGER';
  if (mean > BIAS_T) return 'PATIENT';
  return 'TRUE'; // the reward state: no systematic bias, and the horological
                 // term for a movement running on rate
}

export function consistencyWord(rounds) {
  const rs = normalise(rounds);
  const mean = rs.reduce((s, r) => s + r.e, 0) / rs.length;
  const variance = rs.reduce((s, r) => s + (r.e - mean) ** 2, 0) / rs.length; // population SD
  return Math.sqrt(variance) < CONSIST_T ? 'STEADY' : 'DRIFTING';
}

function signatureLine(input) {
  return `${biasWord(input.rounds)} / ${consistencyWord(input.rounds)} · ${input.tier}`;
}

// Appended, never substituted — a streak rides on top of whichever state the
// day earned. Below STREAK_MIN it renders nothing at all: "🔥 1" is worse than
// silence.
function streakLine(input) {
  return input.streak >= STREAK_MIN ? `🔥 ${input.streak}` : null;
}

// ---- Variants ------------------------------------------------------------

// C — Flawless. Every round perfect. The numerals disappear: this has to look
// structurally unlike anything anyone has seen pasted into a group chat, so it
// registers as an event with no caption.
function renderFlawless(input) {
  const rank = input.globalRank != null ? ` · #${input.globalRank} GLOBAL` : '';
  return [
    `◈ KRONO #${input.puzzleNumber} ◈`,
    '◈ ◈ ◈ ◈ ◈',
    `${input.tier}${rank}`,
  ];
}

// A — Standard, and B — Marked. Identical layout; the only difference in B is
// that perfect rows carry ◈ at centre. No extra lines, no annotation: the
// scarcity of the glyph does the talking.
function renderStandard(input) {
  const rs = normalise(input.rounds);
  const lines = [headerLine(input.puzzleNumber, headlineRate(input.rounds))];
  for (const r of rs) {
    lines.push(
      padRight(r.key, COL_LABEL) + ' '.repeat(COL_GAP) +
      axisRow(r.e, r.isPerfect) + ' '.repeat(COL_GAP) +
      padLeft(formatSigned(r.e), COL_VALUE),
    );
  }
  lines.push(axisLegend());
  lines.push(signatureLine(input));
  return lines;
}

// Compact — for bios, replies and narrow surfaces. Same cellIndex maths,
// bucketed into 7 symmetric bins.
function compactGlyph(errorSeconds) {
  const offset = cellIndex(errorSeconds) - AXIS_CENTRE_IDX; // −7..+7
  const bin = 3 + roundHalfAway((offset * 3) / AXIS_CENTRE_IDX);
  return COMPACT_GLYPHS[Math.max(0, Math.min(COMPACT_GLYPHS.length - 1, bin))];
}

function renderCompact(input) {
  const rs = normalise(input.rounds);
  const glyphs = rs.map((r) => compactGlyph(r.e)).join(' ');
  // A flawless day comes out as "· · · · ·" — the quietest glyph for the rarest
  // outcome, which is the correct inversion.
  return [`KRONO #${input.puzzleNumber} ${glyphs} ${headlineRate(input.rounds).toFixed(2)} s/day`];
}

// Monthly — the hallmark strip. One rarity-graded character per day, a second
// transmission event on a monthly cadence. You brag by showing a RUN, which is
// what turns bad days into texture rather than failures.
export function renderMonthly(month) {
  const strip = month.days.map((d) => {
    if (!d) return HALLMARK_MISSED; // unplayed: a gap, never a "worst" glyph
    return HALLMARK[d.isFlawless ? 'FLAWLESS' : d.tier] || HALLMARK.REGULATED;
  }).join('');
  const label = typeof month.label === 'string' ? month.label : MONTHS[month.monthIndex];
  return `KRONO · ${label}\n${strip}`;
}

export const MONTH_NAMES = MONTHS;

// ---- Entry point ---------------------------------------------------------

// renderShare(input, variant) → the block, as a string.
//   input.rounds       five { key, signedErrorSeconds, isPerfect }, in play order
//   input.tier         authoritative tier, derived from the STORED score
//   input.globalRank   rendered only in the flawless variant
//   input.streak       optional; the trailing line appears only at >= STREAK_MIN
//   input.month        required for the 'monthly' variant
export function renderShare(input, variant = 'default') {
  if (variant === 'monthly') return renderMonthly(input.month || input);

  const allPerfect = input.rounds.length > 0 && input.rounds.every((r) => r.isPerfect);
  let lines;
  if (variant === 'compact') lines = renderCompact(input);
  else if (allPerfect) lines = renderFlawless(input);
  else lines = renderStandard(input);

  const streak = streakLine(input);
  if (streak) lines.push(streak);
  return lines.join('\n');
}

// ---- Accessibility -------------------------------------------------------

const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

// The ASCII block is noise to a screen reader. This parallel summary is what the
// in-app share surface exposes, and it doubles as the image's alt text.
//
// `rateNoun` exists so the spoken text matches the surface it sits on: the text
// block's headline is "s/day", the score card's is "SECONDS OFF", and a screen
// reader hearing a different noun from the one on screen is worse than the two
// surfaces differing from each other. `includeVerdict` is there for the same
// reason: the block ends with a bias/consistency/tier signature and the card
// does not, so the card's summary must not announce one.
export function shareSummary(input, { rateNoun = 'seconds per day', includeVerdict = true } = {}) {
  const rs = normalise(input.rounds);
  const parts = rs.map((r) => {
    const name = ROUND_LONG[r.key] || r.key;
    if (r.isPerfect || r.e === 0) return `${name} perfect`;
    return `${name} ${Math.abs(r.e).toFixed(2)} ${r.e < 0 ? 'early' : 'late'}`;
  });
  const head = `Krono ${input.puzzleNumber}. Rate ${headlineRate(input.rounds).toFixed(2)} ` +
    `${rateNoun}. ${parts.join(', ')}.`;
  if (!includeVerdict) return head;
  const bias = titleCase(biasWord(input.rounds));
  const consistency = consistencyWord(input.rounds).toLowerCase();
  const tier = input.tier.split(' ').map(titleCase).join(' ');
  return `${head} ${bias}, ${consistency}. ${tier}.`;
}

// ---- Platform routing ----------------------------------------------------

// The block only reads correctly in monospace. In a proportional font the
// four-character labels have unequal widths, the left edge of the axis skews,
// and the cluster read — the whole reason for the format — is destroyed. So the
// image path is a FALLBACK, not a degraded text block: never ship the text
// block to a surface that cannot render monospace and hope.
export const PLATFORM_PATHS = {
  slack: 'fence', discord: 'fence', telegram: 'fence', whatsapp: 'fence',
  imessage: 'image', instagram: 'image', stories: 'image',
  x: 'compact', twitter: 'compact',
  clipboard: 'raw',
};

// → { path, variant, text }. `path: 'image'` means the caller must rasterise
// `text` (see js/share-image.js) — it is not safe to paste as-is.
export function shareForPlatform(input, platform) {
  const path = PLATFORM_PATHS[platform] || 'raw';
  const variant = path === 'compact' ? 'compact' : 'default';
  const body = renderShare(input, variant);
  return {
    path,
    variant,
    text: path === 'fence' ? '```\n' + body + '\n```' : body,
  };
}

// ---- Result codec --------------------------------------------------------
//
// A whole day packed into a URL path segment, so the OG card can be rendered
// from the link alone with no storage behind it:
//
//   28.4.0p.6.67.-26.C   →   #28, +0.04 +0.00(perfect) +0.06 +0.67 −0.26, CHRONOMETER
//
// Signed CENTISECONDS per round, `p` suffixed for a perfect round, tier as its
// initial. Two decimals is exactly the share's display resolution, so nothing is
// lost and nothing extra is implied.
//
// SPOILER SAFETY (the same rule as the block): signed error, perfect flag,
// puzzle number and tier — and nothing else. No target durations, no marked
// times, and never Round 4's tick bias.
//
// UNVERIFIED BY CONSTRUCTION: anyone can hand-write a code claiming a flawless
// day. With no backend there is no way around that, and the link is a bragging
// artifact rather than a record. Sign it when there are accounts to sign for.

const TIER_INITIAL = { REGULATED: 'R', CHRONOMETER: 'C', 'MASTER CHRONOMETER': 'M', OBSERVATORY: 'O' };
const TIER_FROM_INITIAL = Object.fromEntries(
  Object.entries(TIER_INITIAL).map(([name, ch]) => [ch, name]));

export function encodeResult(input) {
  const parts = input.rounds.map((r) => {
    const cs = Math.round(round2(r.signedErrorSeconds) * 100);
    return `${cs}${r.isPerfect ? 'p' : ''}`;
  });
  return [input.puzzleNumber, ...parts, TIER_INITIAL[input.tier] || 'R'].join('.');
}

// Returns a ShareInput, or null if the code is malformed. Callers must treat
// null as "not a share link" and fall through — never as an error page.
export function decodeResult(code) {
  if (typeof code !== 'string') return null;
  const parts = code.split('.');
  if (parts.length !== ROUND_KEYS.length + 2) return null;

  const puzzleNumber = Number(parts[0]);
  if (!Number.isInteger(puzzleNumber) || puzzleNumber < 0 || puzzleNumber > 999999) return null;

  const tier = TIER_FROM_INITIAL[parts[parts.length - 1]];
  if (!tier) return null;

  const rounds = [];
  for (let i = 0; i < ROUND_KEYS.length; i++) {
    const m = /^(-?\d{1,5})(p?)$/.exec(parts[i + 1]);
    if (!m) return null;
    rounds.push({
      key: ROUND_KEYS[i],
      signedErrorSeconds: Number(m[1]) / 100,
      isPerfect: m[2] === 'p',
    });
  }
  return { puzzleNumber, rounds, tier };
}
