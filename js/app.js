// app.js — orchestration only. Owns the DOM and the screen state machine, and
// drives the pure modules (generation, scoring, storage). Timing measurement uses
// performance.now() exclusively, captured as the first statement in each handler.

import { generateChallenge } from './daily.js';
import {
  scoreRound, scoreRound5, scoreReaction, dayTotalMs, glyphForBand,
} from './scoring.js';
import {
  load, save, newSession, finalizeDay, lifetimeAverageMs, biasString,
} from './storage.js';
import { buildShareText, copyToClipboard } from './share.js';
import { rngFromString, randInt } from './prng.js';
import { todayUTC, toDateString, msUntilNextUTCMidnight } from './dates.js';
import { logRound, installDataHelper } from './instrumentation.js';
import { feedback, setMuted, isMuted, unlockOnFirstGesture } from './feedback.js';

// ---- Round metadata -------------------------------------------------------
const TOTAL_ROUNDS = 5;
const LAST_ROUND = TOTAL_ROUNDS;
const ROUND_NAMES = {
  1: 'Match the time',
  2: 'Match the time',
  3: 'Guess the time',
  4: 'Reaction',
  5: 'Brain game',
};
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
// TEST HELPER: force round 4 to always score a Perfect, whatever your actual
// reaction was — a quick way to reach the Perfect screen. Off by default so
// real play gets real (calibrated-hard) reaction scoring; flip to true only
// for local testing.
const FORCE_PERFECT_R4 = false;

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
  off:    { bg: 'var(--red)',    copy: 'Missed it' }, // round 4 jump start / no reaction; overridden below
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
  if (index === 4) return reactionRound(index);
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
// Round 4 — reaction (F1 start lights). Five lights fill one at a time on a
// fixed pace; after a SEEDED hold (never rendered, never countable) they all
// go dark at once. React the instant they do — pressing any earlier, at any
// point after the sequence starts, is a false start (flat cap, no credit).
// Timing is press − lightsOut, both performance.now(), each captured as the
// first statement of its handler.
// ==========================================================================
const LIGHT_COUNT = 5;
const LIGHT_STEP_MS = 400;    // fixed pace between each light filling in — never the secret
const REACTION_TIMEOUT_MS = 3000; // no press this long after go-dark counts as no reaction

function reactionRound(index) {
  const holdMs = challenge.round4.holdMs;
  let phase = 'ready'; // ready -> filling -> holding -> dark -> done
  let goDarkAt = 0;
  const timers = [];

  screen(stage({
    counter: `${index} / ${TOTAL_ROUNDS}`,
    center: `<p class="cue">React the instant the lights go out</p>
      <div class="lights" id="lights">${'<span class="light"></span>'.repeat(LIGHT_COUNT)}</div>`,
    hint: spaceHint('start'),
  }), { round: true, bg: ROUND_COLOR[index] });

  bindPress((now) => {
    if (phase === 'ready') return begin();
    if (phase === 'filling' || phase === 'holding') return endRound({ jumpStart: true });
    if (phase === 'dark') return endRound({ reactionMs: now - goDarkAt });
    // phase === 'done': the round is already over, ignore stray input.
  });

  function begin() {
    phase = 'filling';
    feedback.begin();
    setHint('');
    const lightsEl = $app().querySelector('#lights');
    const lightEls = lightsEl.querySelectorAll('.light');
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const t = setTimeout(() => {
        lightEls[i].classList.add('on');
        feedback.lightOn();
        if (i === LIGHT_COUNT - 1) {
          phase = 'holding';
          const darkTimer = setTimeout(() => {
            goDarkAt = performance.now(); // FIRST statement
            phase = 'dark';
            lightsEl.classList.add('out'); // instant — no transition softens this edge
            feedback.lightsOut();
            const missTimer = setTimeout(() => endRound({ noReaction: true }), REACTION_TIMEOUT_MS);
            timers.push(missTimer);
          }, holdMs);
          timers.push(darkTimer);
        }
      }, LIGHT_STEP_MS * (i + 1));
      timers.push(t);
    }
  }

  // Feedback fires immediately here (not on the next screen) so it feels like
  // part of the reaction itself, not a delayed verdict.
  function endRound({ jumpStart = false, noReaction = false, reactionMs = null } = {}) {
    phase = 'done';
    timers.forEach(clearTimeout);
    const scored = (!jumpStart && !noReaction && FORCE_PERFECT_R4) ? 1 : reactionMs;
    const s = scoreReaction(scored, { jumpStart, noReaction });
    if (s.band === 'perfect') feedback.perfect(); else feedback.result(s.band);
    completeRound(index, { roundIndex: index, ...s });
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
    ...(index === 4 ? { reaction: result.reactionMs != null ? result.reactionMs / 1000 : null, jumpStart: result.jumpStart, noReaction: result.noReaction } : {}),
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
  if (band === 'perfect') return showPerfectResult(index);
  // Round 4 already fired its outcome sound the instant it happened (see
  // reactionRound's endRound) — don't play it again when this screen paints.
  if (index !== 4) feedback.result(band);

  const ui = BAND_UI[band] || BAND_UI.red;
  let copy = ui.copy, value, sub = '';
  if (index === 4 && result.jumpStart) {
    copy = 'False start'; value = big(result.scoreMs); // flat 50cs penalty
  } else if (index === 4 && result.noReaction) {
    copy = 'No reaction'; value = big(result.scoreMs); // flat 50cs penalty
  } else if (index === 5 && result.outcome === 'timeout') {
    copy = 'No answer'; value = big(result.scoreMs); // 2:00
  } else if (index === 5 && result.outcome === 'expired') {
    copy = 'Time up'; value = big(result.scoreMs);
  } else {
    value = signed(result.signedMs);
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
function showPerfectResult(index) {
  const isLast = index === LAST_ROUND;
  if (index !== 4) feedback.perfect(); // round 4 already fired this immediately (see endRound)
  screen(`
    <div class="screen stage perfect">
      <div class="perfect-burst" aria-hidden="true"></div>
      <p class="rk">${index} / ${TOTAL_ROUNDS}</p>
      <div class="mid">
        <p class="cue">Only ${perfectCount(index)} people got this today</p>
        <p class="hero word perfect-word">Perfect</p>
      </div>
      <p class="hint">${spaceHint(isLast ? 'see results' : 'continue')}</p>
    </div>
  `, { round: true, bg: 'var(--perfect)' });
  bindResultAdvance(index);
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
// Results
// ==========================================================================
function showResults() {
  const rounds = session.rounds;
  const totalMs = dayTotalMs(rounds);
  const bands = rounds.map((r) => r.band);
  const streak = root.streak.current;
  const avgMs = lifetimeAverageMs(root);
  const bias = biasString(root);
  const beatToday = !DEV && root.personalBest.date === session.date && root.lifetime.days > 1;
  // Daily lock: today's puzzle is already spent. A results screen for an EARLIER
  // day (a new UTC day has arrived since) unlocks PLAY AGAIN again. Dev sessions
  // never lock — they never wrote to stats in the first place.
  const locked = !DEV && session.date === todayUTC();

  const rowsHtml = rounds.map((r) => {
    const target = r.targetMs == null || r.targetMs === 0 ? '—' : big(r.targetMs);
    const you = r.actualMs != null ? big(r.actualMs) : '—';
    const off = big(r.rawErrorMs != null ? r.rawErrorMs : r.scoreMs);
    return `<tr>
      <td><span class="g">${glyphForBand(r.band)}</span> ${ROUND_NAMES[r.roundIndex]}</td>
      <td class="num">${target}</td>
      <td class="num">${you}</td>
      <td class="num">${off}</td>
    </tr>`;
  }).join('');

  screen(`
    <div class="screen results">
      <p class="kicker">KRONO #${challenge.puzzleNumber}${DEV ? ' · TEST' : ''}${beatToday ? ' · ★ BEST' : ''}</p>
      <p class="hero total">${big(totalMs)}<span class="off">s off</span></p>
      <div class="grid-glyphs">${bands.map(glyphForBand).join('')}</div>
      <table class="breakdown"><tbody>${rowsHtml}</tbody></table>
      <div class="stats">
        <div class="stat"><div class="k">Streak</div><div class="v">🔥 ${streak}</div></div>
        <div class="stat"><div class="k">Best</div><div class="v">${root.personalBest.total != null ? big(root.personalBest.total) : '—'}</div></div>
        <div class="stat"><div class="k">Avg</div><div class="v">${avgMs != null ? big(avgMs) : '—'}</div></div>
      </div>
      <p class="bias">${bias}</p>
      <div class="btnrow">
        ${locked
          ? `<div class="btn locked" id="next">
               <span class="lk">NEXT KRONO IN</span>
               <span class="cd" id="countdown">--:--:--</span>
             </div>`
          : `<button class="btn ring" id="again" autofocus>${DEV ? 'NEW TEST' : 'PLAY AGAIN'}</button>`}
        <button class="btn alt" id="share"${locked ? ' autofocus' : ''}>SHARE</button>
      </div>
      <div class="links">
        ${DEV ? '' : '<button class="testlink" id="test">Test challenge →</button>'}
        <button class="testlink" id="reset">Reset stats</button>
      </div>
    </div>
  `, { bg: 'var(--ink)' });

  const againBtn = $app().querySelector('#again'); // absent while locked
  if (againBtn) againBtn.addEventListener('click', () => {
    feedback.tap();
    if (DEV) gotoTestChallenge(); else startPlay();
  });
  if (locked) startCountdown();
  $app().querySelector('#share').addEventListener('click', async () => {
    feedback.tap();
    const text = buildShareText({ puzzleNumber: challenge.puzzleNumber, totalMs, bands, streak, biasString: bias });
    const ok = await copyToClipboard(text);
    toast(ok ? 'COPIED' : 'COPY FAILED');
  });
  const testBtn = $app().querySelector('#test');
  if (testBtn) testBtn.addEventListener('click', () => { feedback.tap(); gotoTestChallenge(); });
  $app().querySelector('#reset').addEventListener('click', () => {
    feedback.tap();
    localStorage.removeItem('chrono');
    location.href = location.pathname; // fresh, back to a clean landing
  });
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
