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

import { ImageResponse, loadGoogleFont } from 'workers-og';
import { decodeResult } from '../js/share.js';
import { cardModel, renderCardHTML, OG_SIZE, CARD_VERSION } from '../js/scorecard.js';

// Satori needs real font buffers — it has none of its own and reads no woff2.
// workers-og ships a Google Fonts loader that handles that; memoise the result
// per isolate so it costs one fetch per cold start, not one per card.
//
// Two faces, matching the in-app card exactly: the display face for the total,
// Archivo for everything else. A card that used a different typeface from the
// screen would be a second design pretending to be the same one.
let fontsPromise = null;
function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([
      loadGoogleFont({ family: 'Archivo', weight: 800 }),
      loadGoogleFont({ family: 'Squada One', weight: 400 }),
    ]).then(([archivo, squada]) => ([
      { name: 'Archivo', data: archivo, weight: 800, style: 'normal' },
      { name: 'Squada One', data: squada, weight: 400, style: 'normal' },
    ])).catch((err) => { fontsPromise = null; throw err; }); // don't cache a failure
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
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Squada+One&family=Archivo:wght@700;800;900&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; background:#0B0B12; color:#fff;
         font-family:'Archivo',ui-sans-serif,system-ui,sans-serif;
         display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:28px; padding:32px; text-align:center; }
  img { width:100%; max-width:760px; height:auto; border-radius:14px; }
  a { display:inline-block; background:#fff; color:#0B0B12; text-decoration:none;
      font-weight:800; letter-spacing:.14em; padding:16px 42px; border-radius:999px; }
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
          fonts: await loadFonts(),
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
