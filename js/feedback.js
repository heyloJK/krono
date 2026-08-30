// feedback.js — sound + haptics. No assets, no network: every tone is synthesized
// with the Web Audio API so the site stays a static, dependency-free bundle.
// Every cue here is a SHORT one-shot (<250ms) tied to a discrete event (a press,
// a reveal). None of it loops or ticks during a measurement phase — that would
// be an audible metronome, exactly what the visual "hard constraint" forbids
// (see the header of styles.css). The reaction round's per-light tick is safe
// because its pace is fixed and public, never the secret being tested.

let muted = false;
let ctx = null;

export function setMuted(v) { muted = !!v; }
export function isMuted() { return muted; }

// Audio can't start until a user gesture unlocks it — call this from the first
// pointerdown/keydown the page sees (see unlockOnFirstGesture below).
function getCtx() {
  if (!muted && !ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() { getCtx(); }

export function unlockOnFirstGesture() {
  const unlock = () => unlockAudio();
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

// One oscillator, one short envelope, then it's gone.
function tone({ freq, freqEnd = null, duration = 0.08, type = 'sine', gain = 0.14, delay = 0 }) {
  if (muted) return;
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function buzz(pattern) {
  if (muted) return;
  if (!('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch { /* some browsers throw off-gesture */ }
}

const RESULT_TONE = {
  green:  { freq: 660, freqEnd: 880, type: 'sine' },
  yellow: { freq: 520, freqEnd: 520, type: 'sine' },
  red:    { freq: 220, freqEnd: 140, type: 'sawtooth' },
  off:    { freq: 180, freqEnd: 90,  type: 'sawtooth' },
};
const RESULT_BUZZ = {
  green: 15, yellow: 12, red: [20, 30, 20], off: [30, 40, 30],
};

// One entry point per event, sound + haptic together, so call sites don't have
// to know the details of either.
export const feedback = {
  tap()        { tone({ freq: 720, duration: 0.045, type: 'sine', gain: 0.10 }); buzz(10); },
  begin()      { tone({ freq: 480, duration: 0.09, type: 'sine', gain: 0.14 }); buzz(15); },
  submit()     { tone({ freq: 560, duration: 0.06, type: 'sine', gain: 0.12 }); buzz(10); },
  lightOn()    { tone({ freq: 900, duration: 0.03, type: 'square', gain: 0.05 }); }, // no buzz — 5 in a row would be noise
  lightsOut()  { tone({ freq: 1200, duration: 0.09, type: 'sine', gain: 0.18 }); buzz(20); },
  miss()       { tone({ freq: 180, freqEnd: 90, duration: 0.22, type: 'sawtooth', gain: 0.16 }); buzz([30, 40, 30]); },
  result(band) {
    tone({ ...(RESULT_TONE[band] || RESULT_TONE.red), duration: 0.18, gain: 0.14 });
    buzz(RESULT_BUZZ[band] || RESULT_BUZZ.red);
  },
  perfect() {
    [660, 880, 1100, 1320].forEach((freq, i) => tone({ freq, duration: 0.12, gain: 0.13, delay: i * 0.07 }));
    buzz([20, 40, 20, 40, 60]);
  },
  toast()      { tone({ freq: 1000, duration: 0.05, type: 'sine', gain: 0.09 }); },
  unmuted()    { tone({ freq: 880, duration: 0.06, type: 'sine', gain: 0.12 }); }, // confirms sound just came back on
};
