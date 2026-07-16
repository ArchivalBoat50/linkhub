import { classifyRequest, deviceFromUA, browserFromUA, ClassifyOpts } from "./bot-detect";
import { renderBotPage, renderHumanPage, renderBounce } from "./render";
import { renderDashboardShell } from "./dashboard";
import { renderAdminShell } from "./admin";
import { loadPageConfig, savePageConfig, ConfigValidationError } from "./page-store";
import { Env, hashVisitor, parseUTM, logVisit, logClick, getAnalyticsSummary } from "./analytics";

// A request is "local dev" when it's coming through `wrangler dev`, where
// request.cf.asn is usually absent. We relax the Meta-ASN check there so
// testing the crawler path with a spoofed UA still reads as verified.
function classifyOpts(request: Request): ClassifyOpts {
  const host = new URL(request.url).hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  return { trustMetaUAWithoutASN: isLocal };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

  return new Response(renderHumanPage(pageConfig, env.PAGE_ID), {
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

  // Human: log the click server-side, then 302 to the real destination.
  const c = extractCtx(request, url);
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
    })
  );

  return new Response(null, {
    status: 302,
    headers: {
      location: link.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
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
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
async function handleAdminUpload(request: Request, env: Env): Promise<Response> {
  if (!checkBearer(request, env.ADMIN_TOKEN)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  if (!env.MEDIA) return jsonResponse({ error: "R2 not configured — bind a MEDIA bucket or paste a hosted URL instead" }, 501);

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!contentType.startsWith("image/")) return jsonResponse({ error: "only image uploads are allowed" }, 415);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return jsonResponse({ error: "empty upload" }, 400);
  if (buf.byteLength > MAX_UPLOAD_BYTES) return jsonResponse({ error: "file too large (max 5 MB)" }, 413);

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
  };
  return map[ct.split(";")[0].trim()] || ".img";
}
