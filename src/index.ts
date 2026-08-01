import { classifyRequest, deviceFromUA, browserFromUA, isInAppWebview, ClassifyOpts } from "./bot-detect";
import { renderBotPage, renderHumanPage, renderBounce } from "./render";
import { renderDashboardShell } from "./dashboard";
import { renderAdminShell } from "./admin";
import { loadPageConfig, savePageConfig, ConfigValidationError } from "./page-store";
import { Env, ClickVia, hashVisitor, parseUTM, logVisit, logClick, getAnalyticsSummary } from "./analytics";

// A request is "local dev" when it's coming through `wrangler dev`, where
// request.cf.asn is usually absent. We relax the Meta-ASN check there so
// testing the crawler path with a spoofed UA still reads as verified.
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
}

function classifyOpts(request: Request): ClassifyOpts {
  return { trustMetaUAWithoutASN: isLocalHost(new URL(request.url).hostname) };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Force HTTPS before anything else. Instagram stores bio links without a
    // scheme and opens them over http://, and the zone had no HTTPS redirect —
    // so REAL traffic was arriving in cleartext (confirmed from the Referer on
    // every logged mobile tap, 2026-07-23). Three separate consequences:
    //   1. the 302 carrying the real destination travelled unencrypted, which
    //      hands the account -> destination association to any network observer
    //      — the exact link this whole design exists to conceal;
    //   2. og:url advertised http:// to Meta's crawler;
    //   3. location.origin was http:, so the iOS escape built an
    //      x-safari-http:// URL instead of x-safari-https://.
    // Cheap to fix here and it applies to every route at once.
    // `cf-visitor` is the signal, NOT url.protocol or the Host header: under
    // `wrangler dev` BOTH of those read "example-links.com" over http (verified —
    // wrangler rewrites request.url to the custom_domain route and the Host
    // header with it), so a host-based check redirects every local request to
    // production. cf-visitor is added by Cloudflare's edge, states the scheme
    // the visitor really used, and is absent in local dev — so this fires in
    // production only, exactly when someone arrived over http.
    const cfVisitor = request.headers.get("cf-visitor");
    if (cfVisitor && cfVisitor.includes('"scheme":"http"')) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (path === "/" || path === "") {
      return handleIndex(request, env, ctx, url);
    }
    if (path.startsWith("/go/")) {
      return handleGo(request, env, ctx, url);
    }
    if (path.startsWith("/icon/")) {
      return handleIcon(request, env, url);
    }
    if (path === "/robots.txt") {
      return handleRobots();
    }
    if (path === "/optout") {
      return handleOptOut(request, env, url);
    }
    if (path === "/dashboard") {
      return new Response(renderDashboardShell(env.PAGE_ID, env.MODEL_NAME), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/api/analytics") {
      return handleAnalytics(request, env);
    }
    if (path === "/admin") {
      return new Response(renderAdminShell(env.PAGE_ID, env.MODEL_NAME), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/api/admin/config") {
      return handleAdminConfig(request, env);
    }
    if (path === "/api/admin/upload") {
      return handleAdminUpload(request, env);
    }
    if (path.startsWith("/media/")) {
      return handleMedia(request, env, url);
    }
    if (path === "/favicon.ico") {
      // No favicon; 204 keeps it out of the logs and off the 404 path.
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// Shared per-request context extraction (used by index + go).
function extractCtx(request: Request, url: URL) {
  const ua = request.headers.get("User-Agent") || "";
  const cf = (request as unknown as { cf?: { country?: string } }).cf || {};
  return {
    ua,
    country: cf.country || null,
    device: deviceFromUA(ua),
    browser: browserFromUA(ua),
    referrer: request.headers.get("Referer") || null,
    utm: parseUTM(url),
    ip: request.headers.get("CF-Connecting-IP") || "0.0.0.0",
  };
}

async function handleIndex(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const cls = classifyRequest(request, classifyOpts(request));
  const c = extractCtx(request, url);
  const [pageConfig, visitorHash] = await Promise.all([
    loadPageConfig(env, env.PAGE_ID),
    hashVisitor(c.ip, env.VISITOR_SALT || "dev-salt"),
  ]);

  const isBot = cls.kind !== "human";
  const botType = cls.kind === "meta_crawler" || cls.kind === "generic_bot" ? cls.botType : null;
  const isIgWebview = cls.kind === "human" && cls.isIgWebview;

  // `x=1` marks the page re-opening in Chrome after the load-time escape. It's
  // the same visitor continuing the same visit, already counted on the webview
  // hop — logging it again would double every escaped visit.
  if (!url.searchParams.has("x") && !hasOptOut(request)) {
    ctx.waitUntil(
      logVisit(env, {
        pageId: env.PAGE_ID,
        isBot,
        botType,
        isIgWebview,
        country: c.country,
        device: c.device,
        browser: c.browser,
        referrer: c.referrer,
        utm: c.utm,
        visitorHash,
      })
    );
  }

  if (isBot) {
    return new Response(renderBotPage(pageConfig, url.origin + "/"), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Do NOT let a shared cache serve this to humans. Private + short.
        "cache-control": "private, max-age=300",
        "vary": "User-Agent",
      },
    });
  }

  // Only the iOS Instagram webview gets the escape script; nobody else pays its
  // bytes. It relies on the `instagram://extbrowser` deeplink, which only the
  // Instagram app answers — so it is gated on the IG webview specifically, not
  // any in-app browser. Android IG escapes server-side in handleGo instead.
  const igEscape = isIgWebview && /iphone|ipad|ipod/i.test(c.ua);

  return new Response(renderHumanPage(pageConfig, env.PAGE_ID, igEscape), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "vary": "User-Agent",
    },
  });
}

// The redirect gate. Real destination URLs only ever exist here, at request
// time, and only for classified-human requests. Everyone else gets a bounce.
async function handleGo(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const linkId = decodeURIComponent(url.pathname.slice("/go/".length));
  const pageConfig = await loadPageConfig(env, env.PAGE_ID);
  const link = pageConfig.links.find((l) => l.id === linkId);

  // Unknown id -> behave like a normal not-found, no information leak.
  if (!link) {
    return new Response(renderBounce(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const cls = classifyRequest(request, classifyOpts(request));

  if (cls.kind !== "human") {
    // Crawler/scraper: never reveal the real URL. Bounce to the clean index.
    return new Response(renderBounce(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "vary": "User-Agent" },
    });
  }

  // Human. Exactly one link_clicks row per tap, which needs care because the
  // two platforms escape at different points:
  //
  // - ANDROID escapes server-side. The webview's request reaches us first and
  //   is logged here; the default browser then re-enters carrying `b=a`, and
  //   that hop must NOT log again — it is the same tap.
  // - iOS escapes on the page, before any request is made. The webview never
  //   reaches the server at all, so the `b=i` hop from Chrome is the ONLY
  //   record of the tap and MUST be logged. (Suppressing it, as an earlier
  //   revision did, silently dropped every successfully-escaped click from
  //   analytics — the escape working would have looked like traffic vanishing.)
  //
  // `e=to` is the iOS fallback hop: the escape was refused, so this request is
  // the tap, and it logs like any other.
  const c = extractCtx(request, url);
  const escapeMark = url.searchParams.get(ESCAPED_PARAM);

  if (escapeMark !== "a" && !hasOptOut(request)) {
    const visitorHash = await hashVisitor(c.ip, env.VISITOR_SALT || "dev-salt");
    ctx.waitUntil(
      logClick(env, {
        pageId: env.PAGE_ID,
        linkId: link.id,
        country: c.country,
        device: c.device,
        referrer: c.referrer,
        utm: c.utm,
        visitorHash,
        via: clickVia(c.referrer, url, escapeMark),
      })
    );
  }

  // Android in-app webview: hand the tap to the device's default browser
  // instead of 302-ing inside Instagram's WebView. Any escape mark means we
  // already tried, so never attempt a second time — that would loop.
  if (escapeMark === null) {
    const intent = androidEscape(c.ua, url);
    if (intent) {
      return new Response(null, {
        status: 302,
        headers: { location: intent, "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: link.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

// Did a human tap a card, or did something just fetch /go/<id>?
//
// A tap is a same-origin navigation from our own page, so it carries a Referer
// naming our host — the page sets no referrer-policy, and same-origin
// navigations send the full URL by default. A bare fetch carries none.
//
// The one genuine exception is the iOS escape: `instagram://extbrowser` hands
// the URL to Safari, which opens it as a fresh navigation with NO Referer. That
// hop is a real tap and looks exactly like a scraper on the Referer alone —
// the `b=i` mark is the only thing that separates them, so it is checked first.
//
// Anything left over is 'direct'. That is not a small residue: before this
// existed, 25 of 70 production rows were bare fetches counted as clicks.
function clickVia(referrer: string | null, url: URL, escapeMark: string | null): ClickVia {
  if (escapeMark === "i") return "escape";
  if (!referrer) return "direct";
  try {
    return new URL(referrer).hostname === url.hostname ? "page" : "direct";
  } catch {
    return "direct";
  }
}

// Marks the second hop of a webview escape: the request the real browser makes
// after we hand the link off to it. Its presence means "already escaped, don't
// try again". The VALUE says which platform escaped, which decides whether this
// hop is the one that logs the click — see handleGo.
//   b=a  Android, escaped server-side; the webview hop already logged
//   b=i  iOS, escaped on the page; this hop is the only record of the tap
const ESCAPED_PARAM = "b";

// Breaks an ANDROID in-app-browser tap (Instagram's WebView and friends) out
// into the device's default browser, via a plain 302 to an `intent://` URI —
// no interstitial, no JS, no added latency. Worth doing: the destination's
// saved login, password autofill, and Google/Apple Pay all live in the real
// browser, while a webview session starts logged-out every time.
//
// Deliberately NO `package=`, so the system resolves the intent with the
// user's DEFAULT browser rather than forcing Chrome. Because the intent
// targets our own domain, no app holds an app-link claim on it, so there's no
// chooser dialog and no bounce back into Instagram. If nothing can handle it,
// `S.browser_fallback_url` puts us back on the normal path.
//
// CLOAKING (invariant #1): the intent URI points at OUR OWN /go/<id>, never at
// the destination. The real URL still appears in exactly one place — the
// `Location` header of a classified-human 302. The default browser simply
// re-requests /go/<id>?b=1 and takes that ordinary 302 from there.
//
// iOS is handled on the PAGE instead (IOS_ESCAPE_SCRIPT in render.ts), not
// here: iOS discards a custom-scheme navigation that has no user gesture
// behind it, so the attempt has to ride the visitor's own tap on the card.
function androidEscape(ua: string, url: URL): string | null {
  if (!isInAppWebview(ua)) return null;
  if (!/android/i.test(ua)) return null;

  // Same /go/<id>, same query (UTMs preserved), plus the already-escaped mark.
  const next = new URL(url.toString());
  next.searchParams.set(ESCAPED_PARAM, "a");
  // scheme=https below is a promise about this URL — make it true rather than
  // trusting how the request arrived (Instagram opens bio links over http).
  if (!isLocalHost(next.hostname)) next.protocol = "https:";

  const target = `${next.host}${next.pathname}${next.search}`;
  return (
    `intent://${target}#Intent;scheme=https;action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${encodeURIComponent(next.toString())};end`
  );
}

// Resolves a link's favicon from its real destination domain, SERVER-SIDE,
// and only for classified-human requests. The real domain never appears in
// the page HTML — the card just references /icon/<id>. A crawler that hits
// this endpoint gets a 1x1 transparent pixel, never a redirect or a URL that
// reveals the destination.
async function handleIcon(request: Request, env: Env, url: URL): Promise<Response> {
  const linkId = decodeURIComponent(url.pathname.slice("/icon/".length));
  const pageConfig = await loadPageConfig(env, env.PAGE_ID);
  const link = pageConfig.links.find((l) => l.id === linkId);

  const cls = classifyRequest(request, classifyOpts(request));
  if (!link || cls.kind !== "human") {
    return transparentPixel();
  }

  let host: string;
  try {
    host = new URL(link.url).hostname;
  } catch {
    return transparentPixel();
  }

  // Google's favicon service is a reliable resolver and keeps us from having
  // to fetch/parse the destination ourselves. The destination host only ever
  // travels in this server-to-server request, never to the client.
  const faviconSrc = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
  try {
    const resp = await fetch(faviconSrc, {
      cf: { cacheTtl: 86400, cacheEverything: true },
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return transparentPixel();
    const buf = await resp.arrayBuffer();
    return new Response(buf, {
      headers: {
        "content-type": resp.headers.get("content-type") || "image/png",
        "cache-control": "public, max-age=86400",
        "referrer-policy": "no-referrer",
      },
    });
  } catch {
    return transparentPixel();
  }
}

function transparentPixel(): Response {
  // 1x1 transparent PNG.
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}

function handleRobots(): Response {
  // Actively discourage the JS-honoring AI/index crawlers from ingesting the
  // page. facebookexternalhit is known NOT to honor robots.txt, so this does
  // not affect link previews — it only asks the AI-training / indexer bots to
  // stay out, which they document as voluntary-compliant.
  const body = [
    "User-agent: meta-externalagent",
    "Disallow: /",
    "",
    "User-agent: meta-webindexer",
    "Disallow: /",
    "",
    "User-agent: meta-externalfetcher",
    "Disallow: /",
    "",
    "User-agent: GPTBot",
    "Disallow: /",
    "",
    "User-agent: CCBot",
    "Disallow: /",
    "",
    "User-agent: *",
    "Disallow: /go/",
    "Disallow: /icon/",
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}

// Own-device opt-out. Testing the escape means hammering the real page from a
// real phone, and those hits land in the same tables as the audience — the
// 30 days to 2026-07-24 carried 98 self-inflicted visits and 18 clicks against
// ~19 real Instagram visits, which made igSharePct read 10.8% when the truth
// was 2.2%. A visitor-hash blocklist can't fix it: hashVisitor() folds in the
// calendar day, so the hash rotates every midnight (and again whenever a phone
// changes IP). A cookie is the one marker that survives both.
//
// COOKIE JARS ARE PER-BROWSER, and the iOS escape deliberately moves the
// visitor from the Instagram webview to Safari — two jars. Opting out in Safari
// does NOT opt out the webview hop, so a full test device needs /optout run in
// both. Belt and braces, since the webview hop is the one that logs on iOS.
const OPTOUT_COOKIE = "lh_optout";

function hasOptOut(request: Request): boolean {
  const cookie = request.headers.get("Cookie") || "";
  return new RegExp(`(?:^|;\\s*)${OPTOUT_COOKIE}=1(?:;|$)`).test(cookie);
}

// GET /optout?t=<ADMIN_TOKEN>          -> stop logging this browser
// GET /optout?t=<ADMIN_TOKEN>&off=1    -> resume logging this browser
//
// Gated on ADMIN_TOKEN so a visitor can't quietly delete themselves from the
// numbers. Deliberately NOT HttpOnly-exempt or cached anywhere.
function handleOptOut(request: Request, env: Env, url: URL): Response {
  if (!timingSafeEqual(url.searchParams.get("t") || "", env.ADMIN_TOKEN || "")) {
    // Same bounce a crawler gets: /optout must not confirm it exists.
    return new Response(renderBounce(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const off = url.searchParams.get("off") === "1";
  const cookie = off
    ? `${OPTOUT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly`
    : `${OPTOUT_COOKIE}=1; Max-Age=63072000; Path=/; SameSite=Lax; Secure; HttpOnly`;

  const body = off
    ? "Logging RESUMED for this browser. Visits and clicks from here count again."
    : "Logging STOPPED for this browser. Re-run with &off=1 to undo.\n\n" +
      "This covers this browser only. The Instagram in-app webview keeps its own\n" +
      "cookie jar, so run this inside the webview too if you test the escape.";

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": cookie,
    },
  });
}

// Bearer-token check against a specific secret. Returns true only when the
// secret is set AND matches. Used by both the dashboard and admin surfaces.
function checkBearer(request: Request, secret: string | undefined): boolean {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return !!secret && timingSafeEqual(token, secret);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handleAnalytics(request: Request, env: Env): Promise<Response> {
  if (!checkBearer(request, env.DASHBOARD_TOKEN)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const pageId = url.searchParams.get("page") || env.PAGE_ID;
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);

  const summary = await getAnalyticsSummary(env, pageId, days);
  return new Response(JSON.stringify(summary), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// GET  -> return the current page config to the authenticated owner (this is
//         the one client-readable place destination URLs legitimately appear,
//         because the caller proved they hold ADMIN_TOKEN).
// PUT  -> validate + persist a new config, bust the cache. See page-store.ts.
async function handleAdminConfig(request: Request, env: Env): Promise<Response> {
  if (!checkBearer(request, env.ADMIN_TOKEN)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    const cfg = await loadPageConfig(env, env.PAGE_ID);
    return jsonResponse(cfg);
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    try {
      const saved = await savePageConfig(env, env.PAGE_ID, body);
      return jsonResponse(saved);
    } catch (e) {
      if (e instanceof ConfigValidationError) return jsonResponse({ error: e.message }, 400);
      return jsonResponse({ error: "save failed" }, 500);
    }
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

// Accepts a raw image body (Content-Type = the image's type) and stores it in
// R2, returning a same-origin /media/<key> path. Requires the MEDIA binding;
// without it, admins paste hosted URLs instead. Size-capped to keep an authed
// but careless upload from writing an unbounded object.
// Images stay small; background videos are allowed larger but still capped so
// an authed-but-careless upload can't write an unbounded object (and to stay
// well within the Worker request-body limit, since we buffer it in memory).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
async function handleAdminUpload(request: Request, env: Env): Promise<Response> {
  if (!checkBearer(request, env.ADMIN_TOKEN)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  if (!env.MEDIA) return jsonResponse({ error: "R2 not configured — bind a MEDIA bucket or paste a hosted URL instead" }, 501);

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const isImage = contentType.startsWith("image/");
  const isVideo = contentType.startsWith("video/");
  if (!isImage && !isVideo) return jsonResponse({ error: "only image or video uploads are allowed" }, 415);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return jsonResponse({ error: "empty upload" }, 400);
  const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (buf.byteLength > max) {
    return jsonResponse({ error: `file too large (max ${isVideo ? 30 : 5} MB)` }, 413);
  }

  const ext = extForContentType(contentType);
  const key = `${crypto.randomUUID()}${ext}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType } });

  return jsonResponse({ url: `/media/${key}` });
}

// Serves an uploaded image from R2. Public (avatars/backgrounds are shown to
// every human visitor anyway) and long-cached; keys are unguessable UUIDs.
async function handleMedia(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const key = decodeURIComponent(url.pathname.slice("/media/".length));
  // Keys we mint are UUID + extension only; reject anything else (path safety).
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) return new Response("Not found", { status: 404 });

  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

// Constant-time-ish string compare to avoid leaking token length/prefix via
// timing. Not cryptographically perfect in JS, but far better than ===.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function extForContentType(ct: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  };
  return map[ct.split(";")[0].trim()] || ".bin";
}
