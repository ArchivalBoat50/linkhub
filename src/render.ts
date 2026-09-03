import { PageConfig, LinkItem } from "./config";

// Shared design tokens.
// Direction: a "VIP access pass" — deep aubergine ground, warm gold + dusty
// mauve accents, serif display paired with a geometric sans. Deliberately
// not the cream/terracotta or near-black/neon defaults.
const STYLE = `
  /* Self-hosted, same-origin webfonts (served from R2 via /media/, see
     handleMedia in index.ts). These used to load from fonts.googleapis.com as a
     render-blocking <link rel="stylesheet">, which then pulled the woff2 from
     fonts.gstatic.com — two extra DNS lookups + TLS handshakes before a single
     character could paint. This page's traffic is all Instagram mobile on
     cellular, where that latency is the difference between a tap and a bounce.
     Declaring @font-face here in the inline STYLE means zero blocking external
     requests: the rules are parsed immediately and the fonts swap in on arrival.
     Both files are VARIABLE fonts — one file spans the whole weight range, so
     listing extra weights costs no extra bytes (and trimming them saves none).
     Latin subset only: non-latin text falls back to the system stack below. */
  @font-face {
    font-family: 'Fraunces';
    font-style: normal;
    font-weight: 500 600;
    src: url(/media/fraunces-latin.woff2) format('woff2');
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Manrope';
    font-style: normal;
    font-weight: 500 700;
    src: url(/media/manrope-latin.woff2) format('woff2');
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  :root {
    --bg: #241220;
    --bg-card: #2E1826;
    --text: #F5EFE6;
    --text-dim: #C9BDB4;
    --gold: #C9A15A;
    --mauve: #C97A94;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: radial-gradient(120% 100% at 50% -10%, #34192C 0%, var(--bg) 55%);
    color: var(--text);
    font-family: 'Manrope', system-ui, -apple-system, sans-serif;
    min-height: 100svh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 18px 48px;
  }
  /* Background media — HUMAN page only; the bot/crawler page never emits any of
     these elements (it always renders the plain gradient above). */
  /* Full-bleed image or video behind everything, under a dark scrim so text
     stays readable over any media. */
  .bg-full { position: fixed; inset: 0; z-index: -2; overflow: hidden; }
  .bg-full > img, .bg-full > video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .bg-scrim { content: ""; position: fixed; inset: 0; z-index: -1;
    background: linear-gradient(180deg, rgba(20,10,17,0.55), rgba(20,10,17,0.82)); }
  /* Top banner strip: full-bleed across the top, card flows below it. The
     negative margins cancel the body padding so it reaches the edges. */
  .banner { align-self: stretch; margin: -32px -18px 26px; height: clamp(150px, 34vh, 280px);
    overflow: hidden; position: relative; }
  .banner > img, .banner > video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .banner::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 55%;
    background: linear-gradient(180deg, transparent, var(--bg)); pointer-events: none; }
  .card { width: 100%; max-width: 420px; }
  .avatar {
    width: 96px; height: 96px; border-radius: 50%;
    margin: 0 auto 18px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(155deg, var(--gold), var(--mauve));
    font-family: 'Fraunces', Georgia, serif; font-size: 32px; font-weight: 600; color: var(--bg);
    box-shadow: 0 0 0 3px rgba(201,161,90,0.25), 0 12px 30px -12px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  /* Empty placeholder styling used when no image is set yet (matches the
     "empty picture placeholder" look). */
  .avatar.placeholder {
    background: repeating-linear-gradient(45deg, #3a2130, #3a2130 10px, #331c2a 10px, #331c2a 20px);
    color: var(--text-dim); font-size: 12px; font-family: 'Manrope', sans-serif; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .bg-placeholder-note {
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.55); color: #fff; font-size: 10px; padding: 4px 10px;
    border-radius: 6px; z-index: 5; letter-spacing: 0.3px;
  }
  h1 {
    font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 26px;
    text-align: center; margin: 0 0 4px; letter-spacing: 0.2px;
  }
  .handle { text-align: center; color: var(--gold); font-size: 14px; margin: 0 0 6px; font-weight: 600; }
  .tagline { text-align: center; color: var(--text-dim); font-size: 14px; margin: 0 0 30px; line-height: 1.5; }
  .links { display: flex; flex-direction: column; gap: 14px; }
  .link-card {
    position: relative;
    display: flex; align-items: center; gap: 14px;
    background: var(--bg-card);
    border: 1px solid rgba(201,161,90,0.18);
    border-radius: 14px;
    padding: 16px 20px 16px 26px;
    text-decoration: none; color: var(--text);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .link-card::before, .link-card::after {
    content: ""; position: absolute; left: -8px; width: 16px; height: 16px;
    background: var(--bg); border-radius: 50%;
  }
  .link-card::before { top: -8px; }
  .link-card::after { bottom: -8px; }
  /* Tap feedback. The card is the only thing on this page a visitor is meant to
     press, and the 302 + destination load can take a second on mobile data —
     longer still on the Instagram escape path, which deliberately waits up to
     1500ms before falling through. A card that looks inert for that long reads
     as broken, and the tap gets repeated or abandoned. */
  .link-card { transition: transform .13s ease, background-color .13s ease, border-color .13s ease; }
  .link-card.tapped, .link-card.loading {
    transform: scale(0.975);
    background: #3A1F31;
    border-color: rgba(201,161,90,0.42);
  }
  /* Inset from all four edges so no overflow:hidden is needed — the notch
     circles above are ::before/::after positioned OUTSIDE the card border, and
     clipping the card to hide a bar overflow would eat them. */
  .link-bar {
    position: absolute; left: 16px; right: 16px; bottom: 6px; height: 2px;
    border-radius: 2px; background: var(--gold);
    transform: scaleX(0); transform-origin: left center;
    opacity: 0; pointer-events: none;
  }
  .link-card.loading .link-bar {
    opacity: 1;
    animation: lh-load 1.5s cubic-bezier(0.15,0.75,0.3,1) forwards;
  }
  /* Stops at 92% and holds. The bar cannot know when the destination has
     loaded — we hand off to a 302 and the page goes away — so filling to 100%
     would assert something we have not observed. Stalling just short reads as
     "still working", which is true. */
  @keyframes lh-load { from { transform: scaleX(0); } to { transform: scaleX(0.92); } }
  @media (prefers-reduced-motion: reduce) {
    .link-card { transition: none; }
    .link-card.tapped, .link-card.loading { transform: none; }
    .link-card.loading .link-bar { animation: none; opacity: 1; transform: scaleX(0.92); }
  }
  .link-icon {
    width: 34px; height: 34px; border-radius: 50%; flex: none;
    background: rgba(201,161,90,0.12);
    display: flex; align-items: center; justify-content: center;
    color: var(--gold);
    overflow: hidden;
  }
  .link-icon img { width: 20px; height: 20px; object-fit: contain; border-radius: 4px; }
  .link-label { font-size: 15px; font-weight: 600; flex: 1; }
  .link-arrow { color: var(--text-dim); font-size: 18px; }
  .foot { text-align: center; margin-top: 34px; color: var(--text-dim); font-size: 11px; letter-spacing: 0.4px; }
`;

function iconSvg(kind: string): string {
  switch (kind) {
    case "vip":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z"/></svg>`;
    case "instagram":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.6" fill="currentColor"/></svg>`;
    case "telegram":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 3L2 11l6 2 2 6 3-4 5 3 3-15z"/></svg>`;
    case "x":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l16 16M20 4L4 20"/></svg>`;
    case "tiktok":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4c1 2 2.5 3 5 3"/></svg>`;
    case "youtube":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
  }
}

// Decide what goes inside a card's logo circle.
// Priority: explicit logoUrl > built-in icon glyph > server-side favicon.
// IMPORTANT: for the favicon fallback we point at /icon/<id> on THIS worker,
// never at a URL containing the real destination domain — otherwise the
// destination (e.g. destination.example) would leak into the page HTML. The worker
// resolves the real favicon server-side, human-gated, in the /icon route.
function cardLogoHtml(l: LinkItem, forBot: boolean): string {
  if (l.logoUrl) {
    return `<img src="${escapeAttr(l.logoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  if (l.icon) {
    return iconSvg(l.icon);
  }
  const faviconOn = l.faviconFallback !== false; // default true
  if (faviconOn && !forBot) {
    // Human page only. Bot page must never emit /icon/<id> (it would let a
    // crawler resolve the favicon and thus the domain), so bots get a glyph.
    return `<img src="/icon/${encodeURIComponent(l.id)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createRange().createContextualFragment(${JSON.stringify(iconSvg("generic"))}))">`;
  }
  return iconSvg("generic");
}

function backgroundMediaEl(cfg: PageConfig): string {
  const url = (cfg.backgroundUrl || "").trim();
  // The media is object-fit: cover, so it overflows its frame on one axis and
  // the focal point decides what survives the crop. validateConfig guarantees
  // this is "<num>% <num>%" — it lands in a style attribute, so nothing else
  // may ever reach here (see the SECURITY note on PageConfig.backgroundPosition).
  const style = ` style="object-position:${escapeAttr(cfg.backgroundPosition || "50% 50%")}"`;
  if (cfg.backgroundMediaType === "video") {
    // iOS blocks muted-video autoplay whenever Low Power Mode or Low Data Mode
    // is on — the correct autoplay/muted/playsinline attributes don't override
    // it. With no poster, WebKit then paints a blank/black frame. Appending a
    // #t=0.001 media fragment forces it to seek to and render the first frame,
    // which stands in as a static poster until (and if) autoplay runs — no
    // separate poster asset to generate or store, and the frame IS the video's
    // first frame, exactly as wanted. The 0.001s offset is imperceptible when
    // autoplay does fire. Skip if the URL already carries a fragment.
    const posterUrl = url.includes("#") ? url : `${url}#t=0.001`;
    return `<video src="${escapeAttr(posterUrl)}"${style} autoplay muted loop playsinline preload="metadata"></video>`;
  }
  return `<img src="${escapeAttr(url)}"${style} alt="" referrerpolicy="no-referrer">`;
}

// HUMAN-only background markup, placed at the top of <body>. Returns "" when
// there's no background or type is "none". The bot page NEVER calls this — a
// crawler must only ever see the plain gradient (no photo, no video). This is
// the same cloaking rule as the profile photo.
function backgroundHtml(cfg: PageConfig): string {
  const url = (cfg.backgroundUrl || "").trim();
  const type = cfg.backgroundType || (url ? "full" : "none");
  if (!url || type === "none") return "";
  const media = backgroundMediaEl(cfg);
  if (type === "banner") return `<div class="banner">${media}</div>`;
  return `<div class="bg-full">${media}</div><div class="bg-scrim"></div>`;
}

function avatarHtml(cfg: PageConfig, forBot: boolean): string {
  // Bot page NEVER shows the real profile photo — initials only, always SFW.
  if (!forBot && cfg.avatarUrl) {
    return `<div class="avatar"><img src="${escapeAttr(cfg.avatarUrl)}" alt="${escapeAttr(cfg.profileName)}" referrerpolicy="no-referrer"></div>`;
  }
  if (cfg.avatarInitials) {
    return `<div class="avatar">${escapeHtml(cfg.avatarInitials)}</div>`;
  }
  // Empty placeholder (matches the "empty picture placeholder" requirement).
  return `<div class="avatar placeholder">Photo</div>`;
}

/**
 * Bot / crawler render: fully static, no JS, no real destination URLs, no
 * /icon or /go references, no real profile photo, no background image.
 * Just a clean, complete, legitimate-looking page.
 */
export function renderBotPage(cfg: PageConfig, canonicalUrl: string): string {
  const linksHtml = cfg.links
    .map(
      (l) => `
      <div class="link-card">
        <div class="link-icon">${cardLogoHtml(l, true)}</div>
        <div class="link-label">${escapeHtml(l.label)}</div>
      </div>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(cfg.profileName)}</title>
<meta name="description" content="${escapeAttr(cfg.ogDescription)}">
<meta property="og:title" content="${escapeAttr(cfg.profileName)}">
<meta property="og:description" content="${escapeAttr(cfg.ogDescription)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${escapeAttr(canonicalUrl)}">
<meta name="robots" content="index, follow">
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    ${avatarHtml(cfg, true)}
    <h1>${escapeHtml(cfg.profileName)}</h1>
    <p class="handle">${escapeHtml(cfg.handle)}</p>
    <p class="tagline">${escapeHtml(cfg.tagline)}</p>
    <div class="links">${linksHtml}</div>
    <p class="foot">&copy; ${new Date().getFullYear()} ${escapeHtml(cfg.profileName)}</p>
  </div>
</body>
</html>`;
}

/**
 * Human render: real destination URLs are NEVER placed in this HTML. Each
 * link points at a relative /go/<id> path; favicons load via /icon/<id>.
 * Both are re-classified server-side. Profile photo + background image are
 * shown here (human only). See ARCHITECTURE.md §2.
 */
export function renderHumanPage(cfg: PageConfig, pageId: string, igEscape = false): string {
  const linksHtml = cfg.links
    .map(
      (l) => `
      <a class="link-card" href="/go/${encodeURIComponent(l.id)}" rel="noopener nofollow" data-link-id="${escapeAttr(l.id)}">
        <div class="link-icon">${cardLogoHtml(l, false)}</div>
        <div class="link-label">${escapeHtml(l.label)}</div>
        <div class="link-arrow">&#8594;</div>
        <span class="link-bar"></span>
      </a>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(cfg.profileName)}</title>
<style>${STYLE}</style>
</head>
<body>
  ${backgroundHtml(cfg)}
  <div class="card">
    ${avatarHtml(cfg, false)}
    <h1>${escapeHtml(cfg.profileName)}</h1>
    <p class="handle">${escapeHtml(cfg.handle)}</p>
    <p class="tagline">${escapeHtml(cfg.tagline)}</p>
    <div class="links" id="links">${linksHtml}</div>
    <p class="foot">&copy; ${new Date().getFullYear()} ${escapeHtml(cfg.profileName)}</p>
  </div>
  ${TAP_FEEDBACK_SCRIPT}${igEscape ? IOS_ESCAPE_SCRIPT : ""}
</body>
</html>`;
}

// Tap feedback for the link cards. Emitted on every HUMAN page (the bot page
// stays JS-free and its cards are inert `div`s with no bar element).
//
// Registered BEFORE the escape script on purpose. Both listen for `click` on
// `#links`, and listeners on the same element fire in registration order — so
// the card lights up first, and the escape's `preventDefault()` then holds the
// visitor on this page for up to 1500ms with the bar already running. That
// window is exactly the one that used to look like a dead tap.
//
// `:active` alone would not do this: iOS only applies it to a link when a touch
// listener exists, and it drops the instant the escape moves focus to Safari,
// which is when the feedback is most needed.
//
// pointerdown (not click) starts the press state so it lands on finger-down
// rather than after the browser's click resolution. Release is deferred 150ms
// so the press doesn't visibly flash off in the gap before `click` adds
// `.loading` — which carries the same pressed styling, so the two hand over
// without a pop.
//
// `pageshow` clears both classes because the Instagram escape leaves this page
// alive in a background tab: without it, returning to the Instagram tab shows
// a card frozen mid-load. It also covers bfcache back-navigation from the
// destination, which is the ordinary way a visitor comes back.
const TAP_FEEDBACK_SCRIPT = `<script>
(function () {
  var l = document.getElementById('links');
  if (!l) return;
  function card(e) { return e.target && e.target.closest ? e.target.closest('a.link-card') : null; }
  l.addEventListener('pointerdown', function (e) { var a = card(e); if (a) a.classList.add('tapped'); });
  function release(e) {
    var a = card(e);
    if (a) setTimeout(function () { a.classList.remove('tapped'); }, 150);
  }
  l.addEventListener('pointerup', release);
  l.addEventListener('pointercancel', release);
  l.addEventListener('click', function (e) { var a = card(e); if (a) a.classList.add('loading'); });
  addEventListener('pageshow', function () {
    var n = l.querySelectorAll('.tapped, .loading');
    for (var i = 0; i < n.length; i++) { n[i].classList.remove('tapped'); n[i].classList.remove('loading'); }
  });
})();
</script>`;

// Instagram in-app-browser escape. Emitted ONLY for an Instagram webview
// visitor, so every other page stays byte-identical (page weight is a
// conversion metric here — see ARCHITECTURE.md, perf pass).
//
// MECHANISM: `instagram://extbrowser/?url=<https url>`. This is Instagram's own
// private deeplink — an instruction to the Instagram app, which is what is
// hosting this webview, to open the given URL in the device's DEFAULT browser
// (Safari for most people). Because it targets the app's own scheme rather than
// a browser's, iOS does NOT gesture-gate it: it fires on page load with no tap.
// That is the whole reason it works where x-safari-/googlechrome- failed —
// those are browser schemes iOS refuses to launch without a user gesture, and
// x-safari- is dead on iOS 26 regardless (all three were tested on a real
// handset 2026-07-23). Confirmed in the wild: this is exactly what a competitor
// (slt.bio / poplink) serves to iOS Instagram webviews, and it lands in Safari.
//
// Android is handled server-side (androidEscape() → intent://), so this file
// only deals with the iOS/Instagram case.
//
// CLOAKING: the only URLs built here are our own origin + our own path. No
// destination string anywhere, and this never reaches the bot page.
//
// TWO escapes, covering different taps:
//
// 1. ON LOAD — moves the whole page to the default browser, so even the
//    BIO-LINK tap escapes, not just a card tap. No fallback needed: if the
//    deeplink somehow doesn't fire, the visitor just stays on the page already
//    in front of them (the pre-escape behaviour). sessionStorage-guarded so
//    returning to the Instagram tab doesn't relaunch it, and the reopened URL
//    carries x=1 so handleIndex doesn't double-count the visit. No loop: the
//    real browser is not an Instagram webview, so it is never served this.
// 2. ON CARD TAP — a safety net for the rare case where (1) didn't run (e.g.
//    sessionStorage blocked). Escapes the specific /go/<id> to the default
//    browser; a short timer falls through to the ordinary in-webview redirect
//    if the deeplink does nothing, cancelled on visibilitychange/pagehide so a
//    successful escape doesn't also fire the fallback. A refused escape must
//    never cost the click.
//
//    THAT CANCELLATION IS A RACE, and it was losing. Both hops log by design —
//    `b=i` is the only record of the tap when the escape works, `e=to` the only
//    record when it doesn't — so if Safari opens without the webview firing
//    visibilitychange inside 1500ms, one tap writes two rows. Two such pairs
//    (1.7s and 3.7s apart, both Instagram mobile) were found in production. The
//    timer now re-checks document.hidden at fire time, which closes the common
//    case; the guarantee is server-side, in logClick()'s dedupe window, because
//    no page-side guard survives a webview torn down mid-handoff.
//
// Keep comments OUT of the emitted string below — those bytes ship to every
// Instagram visitor.
const IOS_ESCAPE_SCRIPT = `<script>
(function () {
  var enc = encodeURIComponent;
  function extbrowser(u) { location.href = 'instagram://extbrowser/?url=' + enc(u); }

  try {
    if (!sessionStorage.getItem('esc')) {
      sessionStorage.setItem('esc', '1');
      extbrowser(location.origin + location.pathname +
        (location.search ? location.search + '&' : '?') + 'x=1');
    }
  } catch (err) {}

  var links = document.getElementById('links');
  if (!links) return;
  links.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.link-card') : null;
    if (!a) return;
    var path = a.getAttribute('href');
    if (!path) return;
    e.preventDefault();
    var timer = setTimeout(function () {
      if (document.hidden) return;
      location.href = path + (path.indexOf('?') > -1 ? '&' : '?') + 'e=to';
    }, 1500);
    function cancel() { clearTimeout(timer); }
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancel(); });
    window.addEventListener('pagehide', cancel);
    extbrowser(location.origin + path + (path.indexOf('?') > -1 ? '&' : '?') + 'b=i');
  });
})();
</script>`;

/**
 * Safe bounce shown when a crawler/scraper hits /go/<id>. No real destination.
 */
export function renderBounce(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=/">
<meta name="robots" content="noindex">
<title>Redirecting</title>
</head><body></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// For attribute values (URLs etc.) — same escaping is safe for our use.
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
