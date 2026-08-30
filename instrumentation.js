// instrumentation.js — local-only event log for tuning the bands and the cap in
// week two. No network. Exposes window.__chronoData() returning the full local
// history as JSON.

import { load } from './storage.js';

const events = [];

// Per-round telemetry. For round 5, `mathCorrect` and `timeToAnswer` are included.
export function logRound(entry) {
  events.push({ t: Date.now(), ...entry });
}

export function installDataHelper() {
  window.__chronoData = function () {
    return {
      state: load(),
      events: events.slice(),
    };
  };
}
