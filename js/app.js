// app.js — orchestration only. Owns the DOM and the screen state machine, and
// drives the pure modules (generation, scoring, storage). Timing measurement uses
// performance.now() exclusively, captured as the first statement in each handler.

import { generateChallenge } from './daily.js';
import {
  scoreRound, scoreRound5, scoreDrift, followedDrift, dayTotalMs, tierForTotalMs,
} from './scoring.js';
import { load, save, newSession, finalizeDay } from './storage.js';
import { shareSummary, encodeResult, headlineRate } from './share.js';
import { cardModel, CARD_VERSION } from './scorecard.js';
import { copyToClipboard } from './clipboard.js';
import { todayUTC, toDateString, msUntilNextUTCMidnight } from './dates.js';
import { logRound, installDataHelper } from './instrumentation.js';
import { feedback, setMuted, isMuted, unlockOnFirstGesture } from './feedback.js';

// ---- Round metadata -------------------------------------------------------
const TOTAL_ROUNDS = 5;
const LAST_ROUND = TOTAL_ROUNDS;
// The share block's four-character labels, in play order — Mark, Fraction,
// Readout, Drift, Split, abbreviated to its fixed column grid (see js/share.js).
// The score card labels its rows ROUND 1–5 instead; the two never appear on the
// same surface.
const SHARE_KEYS = ['MARK', 'FRAC', 'READ', 'DRFT', 'SPLT'];
// ---- Fields and bands -----------------------------------------------------
// A field is a colour AND the text colour that sits on it, always together.
// `light` fields take ink, `dark` fields take white — see tokens.css for the
// measured contrast behind each pairing.
const FIELD = {
  mark:  { bg: 'var(--field-mark)',  tone: 'dark' },   // rounds 1 and 2
  read:  { bg: 'var(--field-read)',  tone: 'dark' },   // rounds 3 and 4
  split: { bg: 'var(--field-split)', tone: 'light' },  // round 5
  surface: { bg: 'var(--surface)', tone: 'dark' },
};
const ROUND_FIELD = {
  1: FIELD.mark, 2: FIELD.mark, 3: FIELD.read, 4: FIELD.read, 5: FIELD.split,
};

// ---- Dev mode -------------------------------------------------------------
// ?dev  → random test challenge, ?date=YYYY-MM-DD → a specific day's challenge.
// Dev sessions are ephemeral and never touch real stats or the daily lock.
const PARAMS = new URLSearchParams(location.search);
const DEV_DATE = /^\d{4}-\d{2}-\d{2}$/.test(PARAMS.get('date') || '') ? PARAMS.get('date') : null;
const DEV = PARAMS.has('dev') || !!DEV_DATE;
// ---- App state ------------------------------------------------------------
let root, today, challenge, session;
let cleanup = [];

const $app = () => document.getElementById('app');

// ---- Helpers --------------------------------------------------------------
function runCleanup() {
  cleanup.forEach((fn) => { try { fn(); } catch {} });
  cleanup = [];
}
function screen(html, { round = false, field = FIELD.surface } = {}) {
  runCleanup();
  document.documentElement.style.setProperty('--screen-bg', field.bg);
  // The text colour rides with the field. Every rule in the stylesheet reads
  // --on-field rather than naming a colour, so this one class swap is what
  // keeps type legible on a bright field and on a deep one alike.
  document.body.classList.toggle('on-light', field.tone === 'light');
  document.body.classList.toggle('on-dark', field.tone !== 'light');
  const app = $app();
  app.className = round ? 'round-screen' : '';
  app.innerHTML = html;
  // Keyboard: land focus on the primary control so every screen is operable
  // without a mouse. Full-viewport tap rounds opt out (Space works globally).
  const af = app.querySelector('[autofocus]');
  if (af) af.focus({ preventScroll: true });
  return app;
}
function persistSession() {
  if (DEV) return;            // dev sessions stay in memory
  root.session = session;
  save(root);
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show'); // CSS transitions the slide+fade; a repeat retargets it
  feedback.toast();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); }, 1600);
}
// ONE numeric form in the whole product: seconds to two decimal places, always
// two. The build previously showed the same quantity three ways — "2:25" on a
// round screen, "4.67" in the field that accepts it, "+1.50" on the card — and
// the colon form additionally read as minutes:seconds, which 8.58 seconds is
// not. Two decimals always, so a column of readings never changes width.
function big(ms) {
  const cs = Math.round(ms / 10);
  return `${Math.floor(cs / 100)}.${String(cs % 100).padStart(2, '0')}`;
}
// Signed error, e.g. +0:12 / −0:32 (U+2212 minus for negatives).
function signed(ms) {
  return (ms < 0 ? '−' : '+') + big(Math.abs(ms));
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// How long until the next puzzle, read ONCE and stated. Not a clock: the old
// build ticked this on setInterval(1000), which is a literal one-second
// metronome running inside a product whose whole subject is that you cannot be
// given one. Coarse on purpose — an hours-and-minutes figure has no second hand
// to entrain to, and nobody needed the seconds.
function untilNext(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} MIN`;
  return m === 0 ? `${h} HR` : `${h} HR ${m} MIN`;
}

// ---- Screen scaffold ------------------------------------------------------
// EVERY screen in the game — the landing and all five rounds — is this stage.
// Five fixed rows: counter, lead line, the measurement, a note slot, the
// instruction. Because the rows are fixed, the measurement occupies the same
// box on every screen; only what is inside it changes. The old scaffold centred
// a flex column, so round 4 drew its "Stop at" 31px higher than round 1 drew
// the identical words, and the landing shared none of the round chrome at all.
//
// Empty slots stay in the markup and keep their height. That is the point: a
// screen with no lead line must not pull the figure upward.
function stage({ counter = '', lead = '', figure = '', note = '', hint = '', cls = '' }) {
  // No measurement on this screen? Collapse the figure slot. Left reserved, it
  // opened a 144px hole between the copy and the note on the two intro screens.
  const kind = figure ? cls : `${cls} intro`;
  return `<div class="screen stage ${kind}">
    <p class="rk">${counter}</p>
    <p class="lead">${lead}</p>
    <div class="field">${figure}</div>
    <div class="note">${note}</div>
    <p class="hint">${hint}</p>
  </div>`;
}
const spaceHint = (verb) => `<span class="key">SPACE</span> to ${verb}`;
const setSlot = (sel, html) => { const n = $app().querySelector(sel); if (n) n.innerHTML = html; };
const setLead = (html) => setSlot('.lead', html);
const setField = (html) => setSlot('.field', html);
const setNote = (html) => setSlot('.note', html);
const setHint = (html) => setSlot('.hint', html);

// The unit every reading in the product is stated in. Identical wording and
// identical treatment on the round result, the results screen and the shared
// card, because they are all reporting the same quantity.
const UNIT = '<p class="note-line">SECONDS OFF</p>';

// The result field, by band. Restored: colour here says how close the reading
// was, which is a second meaning colour carries in this product alongside
// "which round". Both the field and the copy are the original ones; what
// changed is that the type on them is ink, because white measured 2.43:1 on
// green and 2.17:1 on orange and was never readable.
const BAND_UI = {
  green:  { field: { bg: 'var(--band-near)', tone: 'light' }, copy: 'Almost got it' },
  yellow: { field: { bg: 'var(--band-mid)',  tone: 'light' }, copy: 'Not quite' },
  red:    { field: { bg: 'var(--band-far)',  tone: 'light' }, copy: 'Not even close' },
};
const PERFECT_FIELD = { bg: 'var(--band-perfect)', tone: 'light' };
const counterFor = (index) => `${index} / ${TOTAL_ROUNDS}`;

// SPACE / tap binder. `action(now)` receives performance.now() captured as the
// FIRST statement of the handler, so timing-critical presses stay accurate.
// A transparent full-screen layer makes "tap anywhere" work too.
function bindPress(action) {
  const zone = document.createElement('button');
  zone.className = 'tapzone';
  zone.setAttribute('aria-hidden', 'true');
  zone.tabIndex = -1;
  document.body.appendChild(zone);
  const onZone = () => { const now = performance.now(); action(now); };
  zone.addEventListener('click', onZone);
  const onKey = (e) => {
    const now = performance.now(); // FIRST statement
    if (!(e.code === 'Space' || e.key === ' ')) return;
    if (e.repeat) { e.preventDefault(); return; }
    e.preventDefault();
    action(now);
  };
  document.addEventListener('keydown', onKey);
  cleanup.push(() => { zone.remove(); document.removeEventListener('keydown', onKey); });
}

// Parse a typed guess into ms. Accepts "4.67", "4,67", and the on-screen "4:67"
// colon style (part after the colon is centiseconds).
function parseGuessToMs(str) {
  if (str == null) return null;
  let s = String(str).trim().replace(',', '.');
  if (!s) return null;
  if (s.includes(':')) {
    const [secPart, csPart = ''] = s.split(':');
    const sec = parseInt(secPart || '0', 10);
    const cs = parseInt((csPart + '00').slice(0, 2), 10);
    if (!isFinite(sec) || !isFinite(cs) || sec < 0) return null;
    return sec * 1000 + cs * 10;
  }
  const v = parseFloat(s);
  if (!isFinite(v) || v < 0) return null;
  return Math.round(v * 1000);
}
// The entered value. Right-aligned in a fixed slot so the digits already typed
// do not move as more arrive, and no caret, because a blinking caret is a ~1Hz
// metronome on a screen that is timing the player.
const guessField = (inputId) =>
  `<input class="entry" id="${inputId}" inputmode="decimal" placeholder="0.00"
     maxlength="6" aria-label="Your estimate in seconds" autofocus />`;
const guessNote = (inputId) => `<p class="fmt">SECONDS</p>
    <button class="btn" id="${inputId}-submit">SUBMIT</button>`;
// Wire a guess field: focus it, submit on the button or Enter. onSubmit gets ms.
function bindGuess(inputId, onSubmit) {
  const input = $app().querySelector(`#${inputId}`);
  input.focus({ preventScroll: true });
  const submit = () => {
    const guessMs = parseGuessToMs(input.value);
    if (guessMs == null) { input.focus(); return; }
    feedback.submit();
    onSubmit(guessMs);
  };
  $app().querySelector(`#${inputId}-submit`).addEventListener('click', submit);
  // Enter or SPACE submit (SPACE is prevented from typing into the field).
  // stopPropagation so this same keypress can't bubble to document and trip the
  // NEXT screen's SPACE handler (submit renders the result screen synchronously).
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  });
}
function gotoTestChallenge() {
  const base = Date.UTC(2027, 0, 1);
  const d = new Date(base + Math.floor(Math.random() * 3650) * 86400000);
  location.href = location.pathname + '?date=' + toDateString(d);
}
// "2026-08-22" → "22 AUGUST 2026" (parsed as plain parts, no timezone shift).
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ==========================================================================
// Boot
// ==========================================================================
function init() {
  installDataHelper();
  root = load();
  today = DEV_DATE || todayUTC();
  setMuted(root.muted === true);
  unlockOnFirstGesture();
  setupMuteToggle();

  if (DEV) {
    challenge = generateChallenge(today);
    return showLanding();
  }

  // One real puzzle per UTC day. A session completed *today* locks PLAY AGAIN
  // until the next UTC midnight (see showResults); ?dev bypasses all of this.
  const s = root.session;
  if (s && !s.completed && s.rounds.length > 0) {
    // Resume an in-progress game across a refresh.
    session = s;
    challenge = generateChallenge(session.date);
    if (session.round5Started && !session.rounds[4]) {
      return recordRound5(scoreRound5('timeout', { targetMs: null }));
    }
    return showRound(session.currentRound || 1);
  }
  if (s && s.completed) {
    // Land on the results of the last completed game (replayable from there).
    session = s;
    challenge = generateChallenge(session.date);
    return showResults();
  }
  challenge = generateChallenge(todayUTC());
  showLanding();
}

// The mute button lives outside #app (see index.html) so it survives every
// screen swap — wired once at boot, not per-screen.
function setupMuteToggle() {
  const btn = document.getElementById('mute');
  const render = () => {
    // A word, not a 🔊 emoji: an emoji is a different picture on every platform
    // and puts a piece of cartoon art on a measurement instrument.
    btn.textContent = isMuted() ? 'MUTED' : 'SOUND';
    btn.setAttribute('aria-pressed', String(isMuted()));
    btn.setAttribute('aria-label', isMuted() ? 'Unmute sound and haptics' : 'Mute sound and haptics');
  };
  render();
  btn.addEventListener('click', () => {
    const next = !isMuted();
    setMuted(next);
    root.muted = next;
    save(root); // device preference, persisted regardless of ?dev
    render();
    if (!next) feedback.unmuted(); // confirm sound just came back on
  });
}

// ==========================================================================
// Landing
// ==========================================================================
function showLanding() {
  screen(stage({
    counter: `DAILY #${challenge.puzzleNumber}${DEV ? ' · TEST' : ''}`,
    lead: '5 challenges to test your intuition of time',
    figure: '<h1 class="fig word">KRONO</h1>',
    note: `<button class="btn" id="play" autofocus>START</button>
      <button class="linkbtn" id="test">${DEV ? 'Another test challenge' : 'Test challenge'}</button>`,
    hint: prettyDate(challenge.date),
    cls: 'enter',
  }), { field: FIELD.mark });
  $app().querySelector('#play').addEventListener('click', () => { feedback.tap(); startPlay(); });
  $app().querySelector('#test').addEventListener('click', () => { feedback.tap(); gotoTestChallenge(); });
}

function startPlay() {
  if (!DEV) {
    // Today's real puzzle. Re-generated here rather than reused from boot so a
    // tab left open across UTC midnight starts the new day's challenge.
    challenge = generateChallenge(todayUTC());
  }
  session = newSession(challenge.date, challenge.puzzleNumber);
  persistSession();
  showRound(1);
}

// ==========================================================================
// Round router
// ==========================================================================
function showRound(index) {
  session.currentRound = index;
  persistSession();
  if (index === 1 || index === 2) return productionRound(index);
  if (index === 3) return guessRound(index);
  if (index === 4) return driftRound(index);
  if (index === 5) return round5Intro();
  return showResults();
}

// ==========================================================================
// Rounds 1 & 2 — production (hold a duration).
// Flow: "Stop at X" → SPACE to begin (the hold starts on that press) → SPACE to
// stop. No countdown — begin and start-the-hold are the same press.
// ==========================================================================
function productionRound(index) {
  const targetMs = index === 1 ? challenge.round1.targetMs : challenge.round2.targetMs;
  let phase = 'ready', startAt = 0;

  screen(stage({
    counter: counterFor(index),
    lead: 'Stop at',
    figure: `<p class="fig">${big(targetMs)}</p>`,
    hint: spaceHint('begin'),
  }), { round: true, field: ROUND_FIELD[index] });

  bindPress((now) => {
    if (phase === 'ready') begin(now);
    else if (phase === 'running') stop(now);
  });

  function begin(startTime) {
    startAt = startTime; // the press timestamp (captured first) — the hold begins here
    phase = 'running';
    feedback.begin();
    // The target stays up, small, so the hold isn't blind — but it stays in the
    // SAME slot rather than being swapped for the running word, so nothing on
    // screen moves at the instant the measurement starts.
    setLead(big(targetMs));
    setField('<p class="fig word">Running</p>');
    setHint(spaceHint('stop'));
  }

  function stop(now) {
    phase = 'done';
    feedback.tap();
    finishProduction(index, now - startAt, targetMs);
  }
}

function finishProduction(index, measuredMs, targetMs) {
  const s = scoreRound(measuredMs, targetMs);
  completeRound(index, { roundIndex: index, targetMs, actualMs: measuredMs, ...s });
}

// ==========================================================================
// Round 3 — guess a machine-run interval. Score against ACTUAL elapsed time.
// Flow: intro → SPACE to begin → "Running" (machine) → type the guess → SUBMIT.
// ==========================================================================
function guessRound(index) {
  const intendedMs = challenge[`round${index}`].durationMs;
  screen(stage({
    counter: counterFor(index),
    lead: 'We’ll start the clock, you guess the time',
    hint: spaceHint('begin'),
  }), { round: true, field: ROUND_FIELD[index] });

  bindPress((startAt) => start(startAt)); // startAt = performance.now(), captured first

  function start(startAt) {
    feedback.begin();
    screen(stage({ counter: counterFor(index), figure: '<p class="fig word">Running</p>' }),
      { round: true, field: ROUND_FIELD[index] });
    const timer = setTimeout(() => {
      const stopAt = performance.now(); // FIRST statement in callback
      askGuess(stopAt - startAt);
    }, intendedMs);
    cleanup.push(() => clearTimeout(timer));
  }

  function askGuess(actualMs) {
    screen(stage({
      counter: counterFor(index),
      lead: 'How long was that?',
      figure: guessField('guess'),
      note: guessNote('guess'),
      hint: spaceHint('submit'),
    }), { round: true, field: ROUND_FIELD[index] });
    bindGuess('guess', (guessMs) => {
      const s = scoreRound(guessMs, actualMs);
      completeRound(index, {
        roundIndex: index, targetMs: actualMs, actualMs: guessMs, intendedMs, ...s,
      });
    });
  }
}

// ==========================================================================
// Round 4 — Drift. Interval production under a deliberately miscalibrated
// reference: ticks fire at a mean IOI that is 15–25% off a real second (see
// js/daily.js), jittered so they can't be entrained to, and they STOP partway
// through. The player finishes in silence and the error accrues there.
//
// Ticks fire on audio and visual together, from the same timer callback: the
// tone is scheduled on the audio clock immediately and the flash paints on the
// next frame, so the skew stays inside one frame (<20ms). The visual is the
// ellipsis of "Running…" — three dots held dim, one lighting per tick, in
// sequence. It is a single-frame class swap with no transition: a fade or an
// easing curve would smear the onset and hand back a softer, more entrainable
// edge.
//
// The flash leaves no residue, deliberately. Dots light one at a time and go
// back to dim, rather than filling up and staying, so when the train stops at
// the blackout the screen looks exactly as it did before the first tick — it
// never becomes a record of how far the ticks got.
//
// Nothing marks the blackout. The ticks simply stop; announcing it would be one
// more event to time from.
// ==========================================================================
const TICK_DOTS = 3; // the ellipsis of "Running…" doubles as the tick channel

function driftRound(index) {
  const cfg = challenge.round4;
  let phase = 'ready', startAt = 0, tickCount = 0;
  const timers = [];

  screen(stage({
    counter: counterFor(index),
    lead: 'Stop at',
    figure: `<p class="fig">${big(cfg.targetMs)}</p>`,
    note: '<p class="note-line">THE TICKS STOP BEFORE YOU DO</p>',
    hint: spaceHint('begin'),
  }), { round: true, field: ROUND_FIELD[index] });

  bindPress((now) => {
    if (phase === 'ready') begin(now);
    else if (phase === 'running') mark(now);
  });

  function begin(startTime) {
    startAt = startTime; // the press timestamp (captured first) — the interval begins here
    phase = 'running';
    feedback.begin();
    // Target reminder stays up small, as in rounds 1–2, so the hold isn't blind.
    // The dots are always in the markup, only their brightness changes, so a
    // tick can never reflow the line under a player who is watching it.
    setLead(big(cfg.targetMs));
    setField(`<p class="fig word">Running<span class="dots" aria-hidden="true"
        >${'<span>.</span>'.repeat(TICK_DOTS)}</span></p>`);
    setNote('');
    setHint(spaceHint('stop'));

    const dots = $app().querySelectorAll('.dots > span');
    // Every tick is scheduled from the SAME origin, so setTimeout slop can't
    // accumulate across the train — each onset is independently anchored.
    const elapsed = performance.now() - startAt;
    for (const onsetMs of cfg.tickOffsetsMs) {
      timers.push(setTimeout(() => tick(dots), Math.max(0, onsetMs - elapsed)));
    }
  }

  // Each tick lights the NEXT dot and only that one, wrapping round. The cycle
  // length is a red herring, not a period: the onsets are jittered per tick, so
  // three dots never add up to a countable bar.
  function tick(dots) {
    feedback.tick();                 // audio first: it starts on the audio clock
    const dot = dots[tickCount++ % dots.length];
    if (!dot) return;
    dot.classList.add('lit');        // visual: on now, off after one painted frame
    const off = () => dot.classList.remove('lit');
    requestAnimationFrame(() => requestAnimationFrame(off));
    // rAF is throttled to nothing in a backgrounded tab, which would leave the
    // dot stuck lit and swallow every later tick. The timer is a backstop only —
    // when frames are running the double-rAF has already fired.
    timers.push(setTimeout(off, 60));
  }

  function mark(now) {
    phase = 'done';
    timers.forEach(clearTimeout);
    feedback.tap();
    const measuredMs = now - startAt;
    const s = scoreDrift(measuredMs, cfg.targetMs);
    completeRound(index, {
      roundIndex: index,
      targetMs: cfg.targetMs,
      actualMs: measuredMs,
      followedBias: followedDrift(s.signedMs, cfg.biasDir),
      ...s,
    });
  }

  cleanup.push(() => timers.forEach(clearTimeout));
}

// ==========================================================================
// Round 5 — brain game. No pre-delay: the equation shows the instant you start.
// ==========================================================================
function round5Intro() {
  screen(stage({
    counter: counterFor(5),
    lead: 'Solve it, then guess how long it took',
    note: '<p class="note-line">LEAVING THIS SCREEN ENDS THE ROUND</p>',
    hint: spaceHint('begin'),
  }), { round: true, field: ROUND_FIELD[5] });
  bindPress((startAt) => { feedback.begin(); runRound5(startAt); }); // startAt = performance.now(), captured first
}

function runRound5(startAt) {
  const cfg = challenge.round5;
  session.round5Started = true;
  persistSession();

  let resolved = false;
  const timers = [];
  const host = screen('<div class="screen"></div>', { round: true, field: ROUND_FIELD[5] });

  const onHide = () => { if (document.hidden) abandon(); };
  const onBlur = () => abandon();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('blur', onBlur);
  function teardownAttention() {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('blur', onBlur);
  }
  cleanup.push(teardownAttention);
  cleanup.push(() => timers.forEach(clearTimeout));

  function abandon() {
    if (resolved) return;
    resolved = true;
    teardownAttention();
    timers.forEach(clearTimeout);
    recordRound5(scoreRound5('timeout', { targetMs: null }));
  }

  const deadlineTimer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    teardownAttention();
    recordRound5(scoreRound5('timeout', { targetMs: null }));
  }, cfg.deadlineMs);
  timers.push(deadlineTimer);

  // Equation immediately — no blank pre-delay.
  host.innerHTML = stage({
    counter: counterFor(5),
    figure: `<p class="fig">${cfg.a} ${cfg.op} ${cfg.b}</p>`,
    note: '<div class="options" id="options"></div>',
    hint: 'Tap an answer, or keys 1–4',
  });
  const optWrap = host.querySelector('#options');
  cfg.options.forEach((val, i) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.innerHTML = `<span class="okey">${i + 1}</span>${val}`;
    if (i === 0) b.setAttribute('autofocus', '');
    b.addEventListener('click', () => {
      const answerAt = performance.now(); // FIRST statement
      onAnswer(val, answerAt);
    });
    optWrap.appendChild(b);
  });
  optWrap.querySelector('.option')?.focus({ preventScroll: true });
  // Number keys 1–4 select the options.
  const onNum = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= cfg.options.length) {
      const answerAt = performance.now(); // FIRST statement
      e.preventDefault();
      onAnswer(cfg.options[n - 1], answerAt);
    }
  };
  document.addEventListener('keydown', onNum);
  cleanup.push(() => document.removeEventListener('keydown', onNum));

  function onAnswer(chosen, answerAt) {
    if (resolved) return;
    feedback.tap();
    // The 1–4 answer keys must stop intercepting keydown now, or they would
    // preventDefault() the digits 1–4 in the guess input that follows.
    document.removeEventListener('keydown', onNum);
    const intervalMs = answerAt - startAt;
    if (intervalMs > cfg.deadlineMs) {
      resolved = true;
      teardownAttention();
      timers.forEach(clearTimeout);
      return recordRound5(scoreRound5('timeout', { targetMs: null }));
    }
    resolved = true;
    teardownAttention();
    timers.forEach(clearTimeout);
    guessPhase(intervalMs, chosen === cfg.answer);
  }

  function guessPhase(intervalMs, mathCorrect) {
    host.innerHTML = stage({
      counter: counterFor(5),
      lead: 'How long was that?',
      figure: guessField('g5'),
      note: guessNote('g5'),
      hint: spaceHint('submit'),
    });
    let expireTimer = 0;
    bindGuess('g5', (guessMs) => {
      clearTimeout(expireTimer);
      recordRound5(scoreRound5('answered', { actualMs: guessMs, targetMs: intervalMs, mathCorrect }),
        { intervalMs, mathCorrect });
    });
    // Silent backstop: if they never submit, the guess phase expires (no visible clock).
    expireTimer = setTimeout(() => {
      recordRound5(scoreRound5('expired', { targetMs: intervalMs, mathCorrect }), { intervalMs, mathCorrect });
    }, 60000);
    cleanup.push(() => clearTimeout(expireTimer));
  }
}

function recordRound5(s, extra = {}) {
  runCleanup();
  completeRound(5, {
    roundIndex: 5,
    targetMs: s.targetMs ?? extra.intervalMs ?? null,
    actualMs: s.actualMs ?? null,
    mathCorrect: s.mathCorrect ?? extra.mathCorrect ?? null,
    outcome: s.outcome,
    ...s,
  });
}

// ==========================================================================
// Round completion → interstitial → next / results
// ==========================================================================
function completeRound(index, result) {
  session.rounds[index - 1] = result;
  logRound({
    roundIndex: index,
    target: result.targetMs != null ? result.targetMs / 1000 : null,
    actual: result.actualMs != null ? result.actualMs / 1000 : null,
    ...(result.intendedMs != null
      ? { intendedDuration: result.intendedMs / 1000, actualDuration: result.targetMs / 1000 }
      : {}),
    signedError: result.signedMs != null ? result.signedMs / 1000 : null,
    relativeError: result.relError ?? null,
    band: result.band,
    ...(index === 4 ? {
      biasDir: challenge.round4.biasDir,
      biasPct: challenge.round4.biasPct,
      meanIoi: challenge.round4.meanIoiMs / 1000,
      jitterSd: challenge.round4.jitterSdMs / 1000,
      blackout: challenge.round4.blackoutMs / 1000,
      tickCount: challenge.round4.tickOffsetsMs.length,
      followedBias: result.followedBias,
    } : {}),
    ...(index === 5 ? { mathCorrect: result.mathCorrect, timeToAnswer: result.targetMs != null ? result.targetMs / 1000 : null } : {}),
  });

  if (index === LAST_ROUND) {
    session.currentRound = LAST_ROUND + 1;
    finalizeToday();
    session.completed = true;
    persistSession();
    return showResult(LAST_ROUND, result);
  }
  session.currentRound = index + 1;
  persistSession();
  showResult(index, result);
}

// Advance-to-next handler shared by every per-round result screen.
function bindResultAdvance(index) {
  const isLast = index === LAST_ROUND;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    feedback.tap();
    if (isLast) showResults(); else showRound(index + 1);
  };
  bindPress(() => go());
}

// The reading, and a line of copy above it.
//
// A dead-zero offset gets the Perfect screen; everything else is a flat
// band-coloured field. The band colour and the copy are both the originals.
// What is not restored is the fabricated social proof the Perfect screen used
// to carry — "Only 23 people got this today" was generated from a seeded RNG,
// so it stated a fact about other players that did not exist.
function showResult(index, result) {
  const band = result.band || 'red';
  if (band === 'perfect') return showPerfectResult(index, result);
  feedback.result(band);

  const ui = BAND_UI[band] || BAND_UI.red;
  let copy = ui.copy, value, extra = '';
  if (index === 5 && result.outcome === 'timeout') {
    copy = 'No answer';
    value = big(result.scoreMs);
  } else if (index === 5 && result.outcome === 'expired') {
    copy = 'Time up';
    value = big(result.scoreMs);
  } else {
    value = signed(result.signedMs);
    if (index === 4) extra = driftLine(result);
    if (index === 5 && result.mathCorrect === false) {
      extra += '<p class="note-line">+0.50 MATH</p>';
    }
  }

  const isLast = index === LAST_ROUND;
  screen(stage({
    counter: counterFor(index),
    lead: copy,
    figure: `<p class="fig">${value}</p>`,
    note: UNIT + extra,
    hint: spaceHint(isLast ? 'see results' : 'continue'),
  }), { round: true, field: ui.field });
  bindResultAdvance(index);
}

// The Perfect screen — the rarest outcome, so the celebration lives here. The
// burst is the original artwork (cyan core, navy rays); see the note in
// styles.css for why its type is ink and why its one-shot entrance is the
// single documented motion exception on a round screen.
function showPerfectResult(index, result) {
  const isLast = index === LAST_ROUND;
  feedback.result('green');
  screen(stage({
    counter: counterFor(index),
    lead: 'Dead on',
    figure: '<p class="fig word">Perfect</p>',
    note: index === 4 ? driftLine(result) : '',
    hint: spaceHint(isLast ? 'see results' : 'continue'),
    cls: 'perfect',
  }), { round: true, field: PERFECT_FIELD });
  const stageEl = $app().querySelector('.stage');
  const burst = document.createElement('div');
  burst.className = 'perfect-burst';
  burst.setAttribute('aria-hidden', 'true');
  stageEl.prepend(burst);
  bindResultAdvance(index);
}

// Round 4's post-round line — the only place the day's bias is ever stated, and
// the whole tutorial for the round. A fast reference pulls the player early, a
// slow one pulls them late; "followed" is sign agreement with that pull.
function driftLine(result) {
  const { biasDir, biasPct } = challenge.round4;
  const verdict = result.followedBias ? 'You followed it.' : 'You didn’t.';
  return `<p class="drift">Reference ran ${Math.round(biasPct)}% ${biasDir}. ${verdict}</p>`;
}

// ==========================================================================
// Finalize the day into persistent stats (runs once; skipped in dev).
// ==========================================================================
function finalizeToday() {
  const rounds = session.rounds;
  const totalMs = dayTotalMs(rounds);
  const bands = rounds.map((r) => r.band);
  let signedSumMs = 0, targetSumMs = 0;
  for (const r of rounds) {
    if (r.biasEligible !== false && r.signedMs != null && r.targetMs != null) {
      signedSumMs += r.signedMs;
      targetSumMs += r.targetMs;
    }
  }
  if (DEV) return;
  finalizeDay(root, { date: session.date, totalMs, bands, signedSumMs, targetSumMs, roundCount: TOTAL_ROUNDS });
  save(root);
}

// ==========================================================================
// Share
// ==========================================================================
// The share block plots the CAPPED signed error, not the raw one. Two reasons:
// the displayed column then sums to the day total the player is looking at (the
// reconciliation property the format lives or dies on), and the stored, capped
// score stays the single authoritative number for tiers. Nothing is lost on the
// axis either — every cap is far past the half-range, so a capped round pegs
// with ◂/▸ exactly as it should.
function shareSignedMs(r) {
  // Round 5 can end with no signed error at all (no answer, or the guess phase
  // expired). There is no direction to plot, so it is entered as its flat score,
  // late: the player never marked, which is as late as it gets, and the value
  // column still reconciles.
  if (r.signedMs == null) return r.scoreMs;
  const magnitude = r.cappedErrorMs != null ? r.cappedErrorMs : Math.abs(r.signedMs);
  return (r.signedMs < 0 ? -1 : 1) * magnitude;
}

function buildShareInput() {
  return {
    puzzleNumber: challenge.puzzleNumber,
    rounds: session.rounds.map((r, i) => ({
      key: SHARE_KEYS[i],
      signedErrorSeconds: shareSignedMs(r) / 1000,
      isPerfect: r.band === 'perfect',
    })),
    // Authoritative tier, from the stored score — never from the block's
    // rounded headline.
    tier: tierForTotalMs(dayTotalMs(session.rounds)),
    streak: root.streak.current,
    // globalRank stays absent until there is a backend; the flawless variant
    // simply omits the rank clause rather than inventing one.
  };
}

// The permanent link to this result, and the card image behind it. Both are
// generated by the Worker from the code in the path (see worker/index.js), so
// there is nothing to store and nothing to upload at share time.
// Where the link in the share points. The result page rather than the site root:
// it carries the OG tags, so anywhere the TEXT flavour of the clipboard wins —
// Slack, Discord, Notes, email, any plain text field — the link unfurls into the
// card instead of arriving as a bare invite. It costs nothing where the IMAGE
// flavour wins, and the page itself leads to today's puzzle either way.
function resultUrl(input) {
  return `${location.origin}/s/${encodeResult(input)}`;
}
function cardImageUrl(input) {
  // The version token is what lets a redesign reach a cached browser; see
  // CARD_VERSION in js/scorecard.js.
  return `${location.origin}/og/${encodeResult(input)}.png?v=${CARD_VERSION}`;
}

const CARD_MIME = 'image/png';

// One short line. The card carries the detail; a caption competing with it just
// buries the image under text, which is what the old block-first share did.
function shareCaption(input) {
  return `Krono #${input.puzzleNumber} — ${headlineRate(input.rounds).toFixed(2)} seconds off`;
}

async function fetchCardBlob(input) {
  const res = await fetch(cardImageUrl(input), { cache: 'force-cache' });
  if (!res.ok) throw new Error(`card ${res.status}`);
  const blob = await res.blob();
  if (blob.type !== CARD_MIME) throw new Error(`card type ${blob.type}`);
  return blob;
}

// SHARE copies. It deliberately does NOT open a native share sheet: handing the
// card straight to the clipboard keeps the player on the results screen and lets
// them paste wherever they were already going, instead of picking a destination
// out of an OS list first.
async function doShare() {
  const input = buildShareInput();
  const text = `${shareCaption(input)}\n${resultUrl(input)}`;

  // Both the image and the link in ONE clipboard item, so the paste target
  // picks: a message thread takes the image, a plain text field takes the link.
  // The blob is passed as a PROMISE, not an awaited value — Safari only keeps
  // the user gesture alive across the fetch if the item is constructed
  // synchronously with one.
  if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        [CARD_MIME]: fetchCardBlob(input),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      toast('CARD COPIED');
      return;
    } catch { /* no image clipboard, or the card didn't render — fall through */ }
  }

  // Text only. The caption still carries the score, so nothing is lost beyond
  // the picture.
  const ok = await copyToClipboard(text);
  toast(ok ? 'LINK COPIED' : 'COPY FAILED');
}

// ==========================================================================
// Results — the score card
// ==========================================================================
// One row per round: label, a fixed-scale axis, the signed error as a dot, the
// value. The scale is the same 0.50s half-range the text block uses and it is
// NEVER normalised to the day — a bad day pegging at the edge is information,
// not a rendering fault. A pegged row keeps its dot and adds a chevron, so a
// clipped value can't read as a merely-large one.
// The tone is a CLASS, not an inline colour: the dot's two colours are
// --accent and --figure, and a component holding a literal hex is exactly what
// the token layer exists to prevent. A perfect round is no longer a 💎 — it is
// an accent dot at dead centre reading 0.00, which the axis already says more
// precisely than an emoji could, on a surface where emoji do not belong.
function cardRowHtml(row) {
  const pos = `left:${(row.fraction * 100).toFixed(3)}%`;
  return `<div class="cd-label">${row.label}</div>
    <div class="cd-track"><span class="cd-dot ${row.tone}" style="${pos}"></span></div>
    <div class="cd-value">${escapeHtml(row.value)}</div>`;
}

function showResults() {
  const rounds = session.rounds;
  const beatToday = !DEV && root.personalBest.date === session.date && root.lifetime.days > 1;
  // Daily lock: today's puzzle is already spent. A results screen for an EARLIER
  // day (a new UTC day has arrived since) unlocks PLAY AGAIN again. Dev sessions
  // never lock — they never wrote to stats in the first place.
  const locked = !DEV && session.date === todayUTC();

  const shareInput = buildShareInput();
  const card = cardModel(shareInput);

  // The header, the total and the plot are laid out to the SAME rule as the
  // shared image — header left, total left beneath it, plot right, one baseline
  // grid. The old screen centred its header and total while the image
  // left-aligned both, which is what made the thing you look at and the thing
  // you post read as two different designs of one dataset.
  screen(`
    <div class="screen sheet enter">
      <p class="cd-head">KRONO <span class="n">#${card.puzzleNumber}</span>${DEV ? '<span class="n"> · TEST</span>' : ''}${beatToday ? '<span class="n"> · BEST</span>' : ''}</p>
      <div class="card">
        <div class="cd-body">
          <div class="cd-total">
            <p class="cd-num">${card.totalSeconds.toFixed(2)}</p>
            <p class="cd-unit">SECONDS OFF</p>
          </div>
          <div class="cd-plot" aria-hidden="true">
            <span class="cd-centre"></span>
            ${card.rows.map(cardRowHtml).join('')}
          </div>
          <p class="sr-only">${escapeHtml(shareSummary(shareInput, { rateNoun: 'seconds off', includeVerdict: false }))}</p>
        </div>
        <div class="btnrow">
          ${locked
            ? `<div class="spent">NEXT KRONO
                 <span class="when">${untilNext(msUntilNextUTCMidnight())}</span>
               </div>`
            : `<button class="btn" id="again" autofocus>${DEV ? 'NEW TEST' : 'PLAY AGAIN'}</button>`}
          <button class="btn alt" id="share"${locked ? ' autofocus' : ''}>SHARE</button>
          <!-- Account CTA lands here, in the primary slot, once there is a
               backend behind it. The row is already sized for it. -->
        </div>
      </div>
      <div class="links">
        ${DEV ? '' : '<button class="linkbtn" id="test">Test challenge</button>'}
      </div>
    </div>
  `, { field: FIELD.surface });

  const againBtn = $app().querySelector('#again'); // absent while locked
  if (againBtn) againBtn.addEventListener('click', () => {
    feedback.tap();
    if (DEV) gotoTestChallenge(); else startPlay();
  });
  $app().querySelector('#share').addEventListener('click', () => { feedback.tap(); doShare(); });
  const testBtn = $app().querySelector('#test');
  if (testBtn) testBtn.addEventListener('click', () => { feedback.tap(); gotoTestChallenge(); });
}

init();
