// Runtime page-config store.
//
// This is the primitive that lets the profile (name, handle, tagline, avatar,
// background, links) be edited by the admin surface without a redeploy. It
// moves the source of truth from the compile-time `pageConfig` in config.ts to
// a `pages` row in D1, keyed by page_id.
//
// Invariant reminder (ARCHITECTURE.md §14.0): real destination URLs live in
// config_json server-side. They are only ever emitted as a 302 Location on a
// classified-human /go/<id> request, and returned to the *authenticated* owner
// via the admin API. They must never reach an unauthenticated client, a
// crawler, page HTML, or an OG tag. Nothing here serializes a link.url into a
// page — that stays in render.ts's human-gated paths.

import { PageConfig, LinkItem, pageConfig as defaultConfig } from "./config";
import type { Env } from "./analytics";

// Per-isolate cache. Workers spin up many isolates, so this is not a global
// cache — each isolate warms independently and a short TTL bounds how long a
// stale copy can be served after an edit lands in D1. On save we also refresh
// the local entry immediately so the editing isolate is instantly consistent.
const TTL_MS = 60_000;
interface CacheEntry {
  cfg: PageConfig;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Load the config for a page. Order:
 *   1. fresh in-isolate cache entry
 *   2. D1 `pages` row (parsed, then cached)
 *   3. compile-time `pageConfig` fallback (migration safety — a deploy that
 *      hasn't been seeded into D1 yet still serves its original page)
 *
 * The page path is latency-sensitive, so a warm hit does zero I/O.
 */
export async function loadPageConfig(env: Env, pageId: string): Promise<PageConfig> {
  const hit = cache.get(pageId);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.cfg;

  let cfg = defaultConfig;
  try {
    const row = await env.DB.prepare(`SELECT config_json FROM pages WHERE page_id = ?`)
      .bind(pageId)
      .first<{ config_json: string }>();
    if (row?.config_json) {
      const parsed = validateConfig(JSON.parse(row.config_json));
      if (parsed.ok) cfg = parsed.config;
      // A malformed stored row should never take the page down — fall back to
      // the compile-time config rather than serving a broken page.
    }
  } catch {
    // D1 hiccup or missing table (pre-migration): serve the fallback. Do not
    // cache a fallback for the full TTL after a transient error — use a short
    // window so we retry D1 soon.
    cache.set(pageId, { cfg, expires: now + 5_000 });
    return cfg;
  }

  cache.set(pageId, { cfg, expires: now + TTL_MS });
  return cfg;
}

/**
 * Persist a new config for a page and refresh the local cache. Validates
 * before writing so a bad payload can never be stored. Returns the normalized
 * config that was saved.
 */
export async function savePageConfig(env: Env, pageId: string, raw: unknown): Promise<PageConfig> {
  const parsed = validateConfig(raw);
  if (!parsed.ok) throw new ConfigValidationError(parsed.error);
  const cfg = parsed.config;

  await env.DB.prepare(
    `INSERT INTO pages (page_id, config_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
  )
    .bind(pageId, JSON.stringify(cfg), Date.now())
    .run();

  cache.set(pageId, { cfg, expires: Date.now() + TTL_MS });
  return cfg;
}

export class ConfigValidationError extends Error {}

type ValidateResult = { ok: true; config: PageConfig } | { ok: false; error: string };

const ICONS = ["vip", "instagram", "x", "telegram", "tiktok", "youtube", "generic"];

// Server-side validation + normalization. This is the trust boundary for the
// admin API — never store anything this hasn't vetted. It also strips unknown
// keys so config_json only ever holds the shape render.ts expects.
export function validateConfig(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "config must be an object" };
  const r = raw as Record<string, unknown>;

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const modelName = str(r.modelName);
  if (!modelName) return { ok: false, error: "modelName is required" };

  const linksRaw = r.links;
  if (!Array.isArray(linksRaw)) return { ok: false, error: "links must be an array" };
  if (linksRaw.length === 0) return { ok: false, error: "at least one link is required" };

  const ids = new Set<string>();
  const links: LinkItem[] = [];
  for (let i = 0; i < linksRaw.length; i++) {
    const lr = linksRaw[i] as Record<string, unknown>;
    if (typeof lr !== "object" || lr === null) return { ok: false, error: `link ${i + 1} is malformed` };

    const id = str(lr.id);
    if (!id) return { ok: false, error: `link ${i + 1}: id is required` };
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: `link "${id}": id may only contain letters, numbers, - and _` };
    if (ids.has(id)) return { ok: false, error: `duplicate link id "${id}"` };
    ids.add(id);

    const label = str(lr.label);
    if (!label) return { ok: false, error: `link "${id}": label is required` };

    const urlStr = str(lr.url);
    if (!isHttpUrl(urlStr)) return { ok: false, error: `link "${id}": url must be a valid http(s) URL` };

    const link: LinkItem = { id, label, url: urlStr };

    const logoUrl = str(lr.logoUrl);
    if (logoUrl) {
      if (!isHttpUrl(logoUrl) && !isLocalMedia(logoUrl)) return { ok: false, error: `link "${id}": logoUrl must be an http(s) URL` };
      link.logoUrl = logoUrl;
    }
    const icon = str(lr.icon);
    if (icon) {
      if (!ICONS.includes(icon)) return { ok: false, error: `link "${id}": unknown icon "${icon}"` };
      link.icon = icon as LinkItem["icon"];
    }
    if (typeof lr.faviconFallback === "boolean") link.faviconFallback = lr.faviconFallback;

    links.push(link);
  }

  // Optional profile fields. Empty string is allowed (falls back to initials /
  // no background at render time) but a non-empty avatar/background must be a
  // real URL or a /media path we serve.
  const avatarUrl = str(r.avatarUrl);
  if (avatarUrl && !isHttpUrl(avatarUrl) && !isLocalMedia(avatarUrl)) {
    return { ok: false, error: "avatarUrl must be an http(s) URL" };
  }
  const backgroundUrl = str(r.backgroundUrl);
  if (backgroundUrl && !isHttpUrl(backgroundUrl) && !isLocalMedia(backgroundUrl)) {
    return { ok: false, error: "backgroundUrl must be an http(s) URL" };
  }

  // Background layout + media type. Normalize to known values; if a url is set
  // but no explicit type (legacy row), treat it as a full-bleed image.
  const bgTypeRaw = str(r.backgroundType);
  const backgroundType: PageConfig["backgroundType"] =
    bgTypeRaw === "banner" || bgTypeRaw === "full" || bgTypeRaw === "none"
      ? bgTypeRaw
      : backgroundUrl
        ? "full"
        : "none";
  const backgroundMediaType: PageConfig["backgroundMediaType"] =
    str(r.backgroundMediaType) === "video" ? "video" : "image";
  const backgroundPosition = normalizePosition(str(r.backgroundPosition));

  const config: PageConfig = {
    modelName,
    handle: str(r.handle),
    tagline: str(r.tagline),
    avatarInitials: str(r.avatarInitials) || modelName.slice(0, 1).toUpperCase(),
    avatarUrl,
    backgroundUrl,
    backgroundType,
    backgroundMediaType,
    backgroundPosition,
    ogDescription: str(r.ogDescription),
    links,
  };
  return { ok: true, config };
}

// Background focal point, as a CSS object-position value.
//
// This is a hard trust boundary: render.ts interpolates the result straight
// into a style attribute, so anything that isn't exactly "<num>% <num>%" would
// be CSS injection. Rather than rejecting bad input (which would fail a save
// over a cosmetic field), anything unrecognised collapses to the centred
// default — the same thing plain object-fit: cover does. Never loosen this
// regex to allow keywords, calc(), var(), or arbitrary units.
function normalizePosition(s: string): string {
  const m = /^(\d{1,3}(?:\.\d+)?)%[ ]+(\d{1,3}(?:\.\d+)?)%$/.exec(s.trim());
  if (!m) return "50% 50%";
  const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n * 10) / 10));
  return `${clamp(parseFloat(m[1]))}% ${clamp(parseFloat(m[2]))}%`;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// A same-origin media path produced by the R2 upload endpoint (/media/<key>).
function isLocalMedia(s: string): boolean {
  return /^\/media\/[a-zA-Z0-9._-]+$/.test(s);
}
