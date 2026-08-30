// share.js — the acquisition channel. Builds plain-text share content that pastes
// cleanly into any messaging app, and copies it to the clipboard.
//
// Rules (hard requirements): no URL on the first line, at most three lines, no
// leaderboard reference, and NEVER any target times or durations — sharing must
// not spoil the day for the recipient.

import { format, glyphForBand } from './scoring.js';

export function buildShareText({ puzzleNumber, totalMs, bands, streak, biasString }) {
  const line1 = `⏱️ Krono #${puzzleNumber} — ${format(totalMs)}s off`;
  const line2 = bands.map(glyphForBand).join('');
  const streakPart = streak >= 1 ? `🔥 ${streak} · ` : '';
  const line3 = `${streakPart}${biasString}`;
  return `${line1}\n${line2}\n${line3}`;
}

// Async clipboard with a document.execCommand fallback. Resolves true on success.
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
