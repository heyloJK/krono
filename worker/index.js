// worker/index.js — the share link and its Open Graph card.
//
// The site is otherwise static assets; this Worker only handles the two paths
// that can't be files, because their content is the result encoded in the URL:
//
//   /s/28.4.0p.6.67.-26.C       a shareable page whose OG image is the card
//   /og/28.4.0p.6.67.-26.C.png  that card, rendered at 1200×630
//
// Everything else falls through to the static assets. A malformed code is NOT an
// error page — it falls through too, so a truncated or mangled link lands the
// visitor on the game with the site's generic preview.
//
// The card is drawn from cardModel() in js/scorecard.js, the same model the
// in-app screen renders, so the image and the screen cannot drift apart.

import { ImageResponse } from 'workers-og';
import { decodeResult } from '../js/share.js';
import {
  cardModel, renderCardHTML, OG_SIZE, CARD_VERSION, CARD_COLORS,
} from '../js/scorecard.js';

// Satori needs real font buffers — it has none of its own, and it does not
// implement variable-font axes. The screen sets its figures with
// `font-variation-settings: 'wdth' 62` on the variable Archivo; the card cannot,
// so the two grades the card uses are shipped as pre-instanced static TTFs
// (fonts/archivo-figure.ttf and fonts/archivo-label.ttf, generated from the same
// source file the browser loads). Same family, same instances, so the image and
// the screen set the same shapes at the same widths.
//
// They come from this Worker's own assets rather than from Google, so a card
// render depends on no third-party fetch. Memoised per isolate: one read per
// cold start, not one per card.
const FONT_FILES = [
  { name: 'Archivo Figure', path: '/fonts/archivo-figure.ttf' },
  { name: 'Archivo', path: '/fonts/archivo-label.ttf' },
];

let fontsPromise = null;
function loadFonts(env, origin) {
  if (!fontsPromise) {
    fontsPromise = Promise.all(FONT_FILES.map(async ({ name, path }) => {
      const res = await env.ASSETS.fetch(new Request(new URL(path, origin)));
      if (!res.ok) throw new Error(`font ${path} ${res.status}`);
      return { name, data: await res.arrayBuffer(), weight: 800, style: 'normal' };
    })).catch((err) => { fontsPromise = null; throw err; }); // don't cache a failure
  }
  return fontsPromise;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The page a human lands on. Real content, not a bounce: a scraper reads the
// head, and a person gets the score and a way into today's puzzle.
function sharePage(card, code, origin) {
  const title = `Krono #${card.puzzleNumber}`;
  const desc = `${card.totalSeconds.toFixed(2)} seconds off`;
  // Versioned so a redesign re-scrapes; see CARD_VERSION in js/scorecard.js.
  const image = `${origin}/og/${code}.png?v=${CARD_VERSION}`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0B0B12" />
<title>${esc(title)} — ${esc(desc)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Krono" />
<meta property="og:url" content="${esc(origin)}/s/${esc(code)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:image:width" content="${OG_SIZE.width}" />
<meta property="og:image:height" content="${OG_SIZE.height}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(image)}" />
<link rel="preload" href="/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin />
<style>
  /* The same tokens as the app, inlined: this page is one screen served by a
     Worker and is not worth a stylesheet request. Same typeface, same scale,
     same radius, same single button treatment. */
  @font-face { font-family:'Archivo'; font-style:normal; font-weight:500 900;
    font-stretch:62% 125%; font-display:block;
    src:url(/fonts/archivo-latin.woff2) format('woff2'); }
  :root { color-scheme: dark; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; min-height:100dvh; background:${CARD_COLORS.surface}; color:${CARD_COLORS.figure};
         font-family:'Archivo',ui-sans-serif,system-ui,sans-serif; font-weight:500;
         display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:48px; padding:max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
         text-align:center; }
  ::selection { background:${CARD_COLORS.figure}; color:${CARD_COLORS.surface}; }
  img { width:100%; max-width:760px; height:auto; border-radius:12px; }
  a { display:inline-flex; align-items:center; justify-content:center; min-height:72px;
      background:transparent; color:${CARD_COLORS.figure}; text-decoration:none;
      border:2px solid ${CARD_COLORS.figure}; border-radius:999px;
      font-weight:800; font-size:19px; letter-spacing:.2em; padding:16px 48px 16px 51.8px; }
  a:hover, a:focus-visible { background:${CARD_COLORS.figure}; color:${CARD_COLORS.surface}; }
  a:focus-visible { outline:2px solid ${CARD_COLORS.figure}; outline-offset:4px; }
</style>
</head><body>
<img src="${esc(image)}" width="${OG_SIZE.width}" height="${OG_SIZE.height}"
     alt="${esc(title)}: ${esc(desc)}" />
<a href="/">PLAY TODAY'S KRONO</a>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const og = /^\/og\/(.+)\.png$/.exec(url.pathname);
    if (og) {
      const input = decodeResult(decodeURIComponent(og[1]));
      if (!input) return env.ASSETS.fetch(request);
      try {
        return new ImageResponse(renderCardHTML(cardModel(input)), {
          width: OG_SIZE.width,
          height: OG_SIZE.height,
          fonts: await loadFonts(env, url.origin),
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
      } catch (err) {
        // A card that won't render must not break the link: the page keeps its
        // title and description, it just loses the image.
        return new Response(`og render failed: ${err.message}`, { status: 500 });
      }
    }

    const share = /^\/s\/(.+?)\/?$/.exec(url.pathname);
    if (share) {
      const code = decodeURIComponent(share[1]);
      const input = decodeResult(code);
      if (!input) return env.ASSETS.fetch(request);
      return new Response(sharePage(cardModel(input), code, url.origin), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
