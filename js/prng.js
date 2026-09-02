// prng.js — deterministic seeded random.
// Pure, no shared state. Given the same seed string, produces the same sequence
// in every browser. Never uses Math.random().

// cyrb128: hash a string into four 32-bit unsigned integers.
export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// mulberry32: a small, fast, deterministic PRNG. Returns a function that yields
// floats in [0, 1).
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a seeded rng from a seed string.
export function rngFromString(seedString) {
  const seed = cyrb128(seedString);
  return mulberry32(seed[0]);
}

// Helpers built on an rng function ---------------------------------

// Integer in [min, max] inclusive.
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// Pick one element of an array.
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Fisher–Yates shuffle using the rng. Returns a new array.
export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Standard-normal sample (mean 0, SD 1) via Box–Muller. Consumes exactly two
// draws from `rng`, so a caller that needs a stable draw order can count on it.
export function gaussian(rng) {
  const u1 = 1 - rng();  // nudged off zero so log() stays finite
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
