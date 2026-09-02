// app.js — orchestration only. Owns the DOM and the screen state machine, and
// drives the pure modules (generation, scoring, storage). Timing measurement uses
// performance.now() exclusively, captured as the first statement in each handler.

import { generateChallenge } from './daily.js';
import {
  scoreRound, scoreRound5, scoreDrift, followedDrift, dayTotalMs, tierForTotalMs,
} from './scoring.js';
import { load, save, newSession, finalizeDay } from './storage.js';
import { shareSummary, encodeResult, headlineRate } from './share.js';
import { cardModel, TONES, PERFECT_GLYPH, CARD_VERSION } from './scorecard.js';
import { copyToClipboard } from './clipboard.js';
import { rngFromString, randInt } from './prng.js';
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
const ROUND_COLOR = {
  1: 'var(--blue)', 2: 'var(--pink)', 3: 'var(--purple)', 4: 'var(--purple)',
  5: 'var(--brain)',
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
function screen(html, { round = false, bg = 'var(--ink)' } = {}) {
  runCleanup();
  document.documentElement.style.setProperty('--screen-bg', bg);
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
// Time display: seconds:centiseconds, NO leading zero on the seconds — 5450ms →
// "5:45", 870ms → "0:87", 12340ms → "12:34".
function big(ms) {
  const cs = Math.round(ms / 10);
  return `${Math.floor(cs / 100)}:${String(cs % 100).padStart(2, '0')}`;
}
// Signed error, e.g. +0:12 / −0:32 (U+2212 minus for negatives).
function signed(ms) {
  return (ms < 0 ? '−' : '+') + big(Math.abs(ms));
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Countdown clock, HH:MM:SS — used only for "next puzzle in…" on the results
// screen, where a ticking display is safe (no round is being timed).
function hhmmss(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

// ---- Screen scaffold ------------------------------------------------------
// Every round screen is a 3-zone stage: top counter (.rk), centred content
// (.mid), bottom hint (.hint). .rk/.hint are pinned to the viewport by CSS so
// .mid stays dead-centre. The hint element is always present (may be empty).
function stage({ counter, center, hint = '', cls = '' }) {
  return `<div class="screen stage ${cls}">
    <p class="rk">${counter}</p>
    <div class="mid">${center}</div>
    <p class="hint">${hint}</p>
  </div>`;
}
const spaceHint = (verb) => `Hit <span class="key">SPACE</span> to ${verb}`;
const setMid = (html) => { const m = $app().querySelector('.mid'); if (m) m.innerHTML = html; };
const setHint = (html) => { const h = $app().querySelector('.hint'); if (h) h.innerHTML = html; };

// Result-screen colour + copy by band. `perfect` gets its own animated screen
// (see showPerfectResult); the rest are a flat field + encouraging copy.
const BAND_UI = {
  green:  { bg: 'var(--green)',  copy: 'Almost got it' },
  yellow: { bg: 'var(--yellow)', copy: 'Not quite' },
  red:    { bg: 'var(--red)',    copy: 'Not even close' },
};

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
// Shared guess markup: a cue over a big white type-in field and a SUBMIT button.
const guessCenter = (cueText, inputId) => `<p class="cue">${cueText}</p>
    <div class="guess">
      <input id="${inputId}" inputmode="decimal" placeholder="0.00" aria-label="Your estimate in seconds" autofocus />
      <p class="fmthint">seconds — e.g. 4.67</p>
      <button class="btn" id="${inputId}-submit">SUBMIT</button>
    </div>`;
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
    btn.textContent = isMuted() ? '🔇' : '🔊';
    btn.classList.toggle('is-muted', isMuted());
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
  screen(`
    <div class="screen landing enter">
      <h1 class="wordmark">KRONO</h1>
      <p class="prompt lead">5 challenges to test your intuition of time</p>
      <button class="btn ring" id="play" autofocus>START</button>
      <button class="testlink" id="test">${DEV ? '↻ Another test challenge' : 'Play a test challenge →'}</button>
    </div>
    <p class="landing-foot">DAILY #${challenge.puzzleNumber} <span class="dot">•</span> ${prettyDate(challenge.date)}${DEV ? ' · TEST' : ''}</p>
  `, { bg: 'var(--blue)' });
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
    counter: `${index} / ${TOTAL_ROUNDS}`,
    center: `<p class="cue">Stop at</p><p class="hero">${big(targetMs)}</p>`,
    hint: spaceHint('begin'),
  }), { round: true, bg: ROUND_COLOR[index] });

  bindPress((now) => {
    if (phase === 'ready') begin(now);
    else if (phase === 'running') stop(now);
  });

  function begin(startTime) {
    startAt = startTime; // the press timestamp (captured first) — the hold begins here
    phase = 'running';
    feedback.begin();
    // Target reminder stays up small, so the player isn't holding blind.
    setMid(`<p class="cue">${big(targetMs)}</p><p class="hero word">Running</p>`);
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
    counter: `${index} / ${TOTAL_ROUNDS}`,
    center: `<p class="prompt-xl">We’ll start the clock, you guess the time</p>`,
    hint: spaceHint('begin'),
  }), { round: true, bg: ROUND_COLOR[index] });

  bindPress((startAt) => start(startAt)); // startAt = performance.now(), captured first

  function start(startAt) {
    feedback.begin();
    screen(stage({ counter: `${index} / ${TOTAL_ROUNDS}`, center: `<p class="hero word">Running</p>` }),
      { round: true, bg: ROUND_COLOR[index] });
    const timer = setTimeout(() => {
      const stopAt = performance.now(); // FIRST statement in callback
      askGuess(stopAt - startAt);
    }, intendedMs);
    cleanup.push(() => clearTimeout(timer));
  }

  function askGuess(actualMs) {
    screen(stage({
      counter: `${index} / ${TOTAL_ROUNDS}`,
      center: guessCenter('How long was that?', 'guess'),
      hint: spaceHint('submit'),
    }), { round: true, bg: ROUND_COLOR[index] });
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
    counter: `${index} / ${TOTAL_ROUNDS}`,
    center: `<p class="cue">Stop at</p><p class="hero">${big(cfg.targetMs)}</p>
      <p class="cue tiny">The ticks stop before you do</p>`,
    hint: spaceHint('begin'),
  }), { round: true, bg: ROUND_COLOR[index] });

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
    setMid(`<p class="cue">${big(cfg.targetMs)}</p>
      <p class="hero word">Running<span class="dots" aria-hidden="true"
        >${'<span>.</span>'.repeat(TICK_DOTS)}</span></p>`);
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
    counter: `5 / ${TOTAL_ROUNDS}`,
    center: `<p class="prompt-xl">Solve it, then guess how long it took</p>
      <p class="cue tiny">Stay on this screen — leaving ends the round</p>`,
    hint: spaceHint('begin'),
  }), { round: true, bg: ROUND_COLOR[5] });
  bindPress((startAt) => { feedback.begin(); runRound5(startAt); }); // startAt = performance.now(), captured first
}

function runRound5(startAt) {
  const cfg = challenge.round5;
  session.round5Started = true;
  persistSession();

  let resolved = false;
  const timers = [];
  const host = screen('<div class="screen"></div>', { round: true, bg: ROUND_COLOR[5] });

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
    counter: `5 / ${TOTAL_ROUNDS}`,
    center: `<p class="hero sm">${cfg.a} ${cfg.op} ${cfg.b}</p><div class="options" id="options"></div>`,
    hint: 'Tap an answer · or keys 1–4',
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
      counter: `5 / ${TOTAL_ROUNDS}`,
      center: guessCenter('How long was that?', 'g5'),
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

// A dead-0 offset earns the celebratory Perfect screen; everything else is a
// flat band-coloured field with encouraging copy and the SIGNED error. No
// auto-advance — the player presses SPACE (or taps) to move on.
function showResult(index, result) {
  const band = result.band || 'red';
  if (band === 'perfect') return showPerfectResult(index, result);
  feedback.result(band);

  const ui = BAND_UI[band] || BAND_UI.red;
  let copy = ui.copy, value, sub = '';
  if (index === 5 && result.outcome === 'timeout') {
    copy = 'No answer'; value = big(result.scoreMs); // 2:00
  } else if (index === 5 && result.outcome === 'expired') {
    copy = 'Time up'; value = big(result.scoreMs);
  } else {
    value = signed(result.signedMs);
    if (index === 4) sub = driftLine(result);
    if (index === 5 && result.mathCorrect === false) sub = '<p class="cue tiny">+0:50 math</p>';
  }

  const isLast = index === LAST_ROUND;
  screen(stage({
    counter: `${index} / ${TOTAL_ROUNDS}`,
    center: `<p class="cue">${copy}</p><p class="hero">${value}</p>${sub}`,
    hint: spaceHint(isLast ? 'see results' : 'continue'),
    cls: 'reveal',
  }), { round: true, bg: ui.bg });
  bindResultAdvance(index);
}

// The Perfect screen — a comic-book burst (cyan core, navy rays) whose rays
// rotate slowly. The rarest outcome (offset 0), so the celebration lives here.
function showPerfectResult(index, result) {
  const isLast = index === LAST_ROUND;
  feedback.perfect();
  screen(`
    <div class="screen stage perfect">
      <div class="perfect-burst" aria-hidden="true"></div>
      <p class="rk">${index} / ${TOTAL_ROUNDS}</p>
      <div class="mid">
        <p class="cue">Only ${perfectCount(index)} people got this today</p>
        <p class="hero word perfect-word">Perfect</p>
        ${index === 4 ? driftLine(result) : ''}
      </div>
      <p class="hint">${spaceHint(isLast ? 'see results' : 'continue')}</p>
    </div>
  `, { round: true, bg: 'var(--perfect)' });
  bindResultAdvance(index);
}

// Round 4's post-round line — the only place the day's bias is ever stated, and
// the whole tutorial for the round. A fast reference pulls the player early, a
// slow one pulls them late; "followed it" is sign agreement with that pull.
function driftLine(result) {
  const { biasDir, biasPct } = challenge.round4;
  const verdict = result.followedBias ? 'You followed it.' : 'You didn’t.';
  return `<p class="cue tiny">Reference ran ${Math.round(biasPct)}% ${biasDir}. ${verdict}</p>`;
}

// Social-proof flavour for the Perfect screen. No backend yet (Phase 0), so it's
// a small number seeded by the day + round — stable across refresh/replay.
function perfectCount(index) {
  return randInt(rngFromString(`perfect-${challenge.date}-${index}`), 2, 40);
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
function cardRowHtml(row) {
  const pos = `left:${(row.fraction * 100).toFixed(3)}%`;
  const mark = row.isPerfect
    ? `<span class="cd-perfect" style="${pos}">${PERFECT_GLYPH}</span>`
    : `<span class="cd-dot" style="${pos};background:${TONES[row.tone].color}"></span>` +
      (row.pegged
        ? `<span class="cd-peg cd-peg-${row.side}" style="background:${TONES[row.tone].color}"></span>`
        : '');
  return `<div class="cd-label">${row.label}</div>
    <div class="cd-track">${mark}</div>
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

  screen(`
    <div class="screen results card">
      <p class="cd-head">KRONO <span class="n">#${card.puzzleNumber}</span>${DEV ? '<span class="n"> · TEST</span>' : ''}${beatToday ? '<span class="n"> · ★ BEST</span>' : ''}</p>
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
          ? `<div class="btn locked" id="next">
               <span class="lk">NEXT KRONO IN</span>
               <span class="cd" id="countdown">--:--:--</span>
             </div>`
          : `<button class="btn ring" id="again" autofocus>${DEV ? 'NEW TEST' : 'PLAY AGAIN'}</button>`}
        <button class="btn alt" id="share"${locked ? ' autofocus' : ''}>SHARE</button>
        <!-- Account CTA lands here, in the primary slot, once there is a backend
             behind it. The row is already sized for it. -->
      </div>
      <div class="links">
        ${DEV ? '' : '<button class="testlink" id="test">Test challenge →</button>'}
      </div>
    </div>
  `, { bg: 'var(--ink)' });

  const againBtn = $app().querySelector('#again'); // absent while locked
  if (againBtn) againBtn.addEventListener('click', () => {
    feedback.tap();
    if (DEV) gotoTestChallenge(); else startPlay();
  });
  if (locked) startCountdown();
  $app().querySelector('#share').addEventListener('click', () => { feedback.tap(); doShare(); });
  const testBtn = $app().querySelector('#test');
  if (testBtn) testBtn.addEventListener('click', () => { feedback.tap(); gotoTestChallenge(); });
}

// Ticks the "next puzzle in" clock on a locked results screen. When the UTC date
// rolls over it re-renders the screen, which comes back unlocked. Registered in
// `cleanup`, so any screen swap (including that re-render) stops the interval.
function startCountdown() {
  const el = $app().querySelector('#countdown');
  if (!el) return;
  const tick = () => {
    if (todayUTC() !== session.date) return showResults(); // new UTC day — unlock
    el.textContent = hhmmss(msUntilNextUTCMidnight());
  };
  tick();
  const id = setInterval(tick, 1000);
  cleanup.push(() => clearInterval(id));
}

init();
