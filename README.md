# Chrono — Phase 0

A daily timing-accuracy game. Five rounds, one shot each, same five for everyone,
resets at midnight UTC. No running clock is ever shown — you're scored on how many
seconds you were off in total, and you share that number.

This is **Phase 0**: the complete single-player daily loop with local persistence
and a share card. No accounts, no server, no leaderboard.

## Run it

No build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
python3 serve.py
# → http://localhost:8777
```

or any static server, e.g. `npx serve` / `python3 -m http.server`.

### Replay & testing

The once-per-day lock is **live**: one puzzle per real UTC day, keyed to
`todayUTC()`.

- **PLAY AGAIN** on the results screen is replaced by a **NEXT KRONO IN hh:mm:ss**
  countdown once today's puzzle is done. It unlocks on its own at UTC midnight —
  the countdown re-renders the screen in place, no reload needed. SHARE, the
  test-challenge link, and Reset stats all keep working while locked.
- `?dev` / `?date=YYYY-MM-DD` — an isolated test challenge that ignores the lock
  and never writes to stats. **This is the way to replay freely**, and the link to
  share if you want someone to try it more than once a day. The **"Play a test
  challenge →"** link uses it.
- **Reset stats** (results screen) wipes local storage back to a clean slate,
  which also clears the lock.

### Keyboard

Fully playable without a mouse. The primary control on every screen is focused on
arrival. **Space** starts/stops the hold rounds and the reaction; **Enter** submits
guesses; **1–4** pick the brain-game answers (also click / Tab + Enter).

## Rounds

1. **Match the time** — hold a clean target (1.00–9.00s, 0.25 steps).
2. **Match the time** — hold an awkward, uncountable target (0.40–9.00s).
3. **Guess the time** — the machine runs a hidden interval (0.30–9.50s); estimate
   it (scored against actual elapsed, not the intended `setTimeout`).
4. **Reaction** — Formula 1 start lights: five reds fill, hold a seeded delay,
   then go dark. React the instant they do. Reacting early is a false start.
5. **Brain game** — solve one equation, then estimate the whole interval from
   START to your answer. The equation appears immediately (no pre-delay). The
   answer deadline is never shown; leaving the screen ends the round.

## Architecture

Challenge generation, scoring, and rendering are kept in **separate modules with
no shared state**, so Phase 3 can run generation and scoring server-side unchanged.

| File | Role | Pure? |
|---|---|---|
| `js/prng.js` | `cyrb128` + `mulberry32` seeded RNG | ✓ |
| `js/dates.js` | UTC date maths, puzzle number, launch epoch | ✓ |
| `js/daily.js` | **Generation** — date → byte-identical challenge | ✓ |
| `js/scoring.js` | **Scoring** — error, cap, bands, reaction, round 5 outcomes | ✓ |
| `js/storage.js` | Versioned `localStorage`, streak/PB/lifetime/bias | ✓ |
| `js/share.js` | Share text + clipboard (async API + `execCommand`) | ✓ |
| `js/instrumentation.js` | Local event log, `window.__chronoData()` | — |
| `js/app.js` | **Rendering** — DOM, screen state machine, round controllers | — |

### Timing

- Measurement uses `performance.now()` exclusively, captured as the first
  statement in each event handler (never inside `setState`/`useEffect`).
- Round 3 schedules with `setTimeout` but scores against the **actual** elapsed
  time recorded at stop, not the intended duration (`setTimeout` drifts).
- Round 4's reaction is `press − lightsOut`, both `performance.now()`; the seeded
  hold before lights-out is the anti-cheat and is never countable.
- All durations are stored as **integer milliseconds**; seconds are produced only
  at render time.

### Determinism

Every challenge parameter is drawn from `mulberry32(cyrb128("chrono-" + YYYY-MM-DD))`
in a fixed, documented order (see the header of `js/daily.js`). Two browsers on the
same UTC date get identical targets, durations, equations, reaction holds, and
deadlines. `Math.random()` is never used in generation.

> **Puzzle number** counts days since `LAUNCH_EPOCH` in `js/dates.js` — currently
> `2026-08-30` (= #1), the friends-testing deploy date. Moving the epoch shifts every
> puzzle number and nothing else, so set it to the real public launch date when there
> is one. Dates before the epoch are zero/negative; that's expected.

### The hard constraint

Nothing on a round screen has a period. No pulses, spinners, or looping keyframes —
any loop is a metronome that hands the player a reference. The reaction lights are a
one-shot sequence (not a loop), and the delay before they go dark is seeded and
unpredictable. Visual energy lives on the results screen, where timing no longer
matters.

### Visual language

Bold, colourful, minimal: each screen is a full-bleed colour field (electric blue,
pink, purple, orange, ink) with huge condensed numerals (Anton), clean labels
(Archivo), and white pill buttons. Times are shown big as `SS:CC`.

### Round 5 anti-cheat

The answer deadline is never rendered and never enters the DOM. Backgrounding the
tab, blurring the window, or refreshing between START and answer scores a flat
2.00s and skips the guess phase.

## Debugging

`window.__chronoData()` returns the full local state and per-round event log
(`roundIndex`, `target`, `actual`, `signedError`, `relativeError`, `band`; round 3
adds `intendedDuration` vs `actualDuration`, round 4 adds `reaction`/`jumpStart`/
`noReaction`, round 5 adds `mathCorrect`).

The band thresholds and the 1.50s cap are calibrated guesses to be retuned once
there is real data — and only those, so scores stay comparable across the change.

### Round 4 scoring

Unlike every other round, round 4 doesn't add its raw error to the day total —
each tier adds a FLAT number of centiseconds, judged on displayed reaction time
(cs = ms/10, upper bound inclusive):

| Reaction | Band | Adds to total |
|---|---|---|
| under 25cs | Perfect 💎 | 0cs |
| 25–29cs | Green 🟩 | 10cs |
| 30–34cs | Yellow 🟨 | 20cs |
| 35cs+ | Red 🟥 | 30cs |
| jump start, or no press within 3s of lights-out | — | 50cs |
