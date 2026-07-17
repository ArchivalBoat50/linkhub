// Compile-time SEED / FALLBACK config.
//
// As of the admin surface, the live source of truth is the `pages` row in D1
// (see src/page-store.ts). This object is now the fallback used when a deploy
// hasn't been seeded into D1 yet, and the initial value the admin editor loads
// before the first save. Editing this file still works for a fresh deploy;
// once you save from /admin, the D1 row wins.

export interface LinkItem {
  id: string;          // stable id, used as the analytics key — don't reuse ids across unrelated links
  label: string;        // what the human sees
  url: string;           // real destination — read ONLY in the /go/<id> and /icon/<id> routes (index.ts), never rendered into any page. See ARCHITECTURE.md §2.

  // Per-card logo. Priority order at render time:
  //   1. logoUrl  — an explicit image URL you paste in (wins if set)
  //   2. icon     — one of the built-in inline SVG glyphs below
  //   3. favicon  — if neither is set AND faviconFallback is true, the card
  //                 loads /icon/<id>, which fetches the destination's favicon
  //                 SERVER-SIDE (so the real domain never appears in page HTML)
  logoUrl?: string;
  icon?: "vip" | "instagram" | "x" | "telegram" | "tiktok" | "youtube" | "generic";
  faviconFallback?: boolean; // default true — use destination favicon when no logoUrl/icon
}

// How the background media is laid out on the HUMAN page.
//   none   — plain gradient (also the bot page's only look)
//   banner — a strip across the top, card sits below it
//   full   — full-bleed behind the whole card, under a dark scrim
export type BackgroundType = "none" | "banner" | "full";
// Whether backgroundUrl points at an image or a (muted, looping) video.
export type BackgroundMediaType = "image" | "video";

export interface PageConfig {
  modelName: string;          // shown to bots / in OG tags — keep this brand-neutral and clean
  handle: string;              // e.g. "@yourhandle" shown on the page
  tagline: string;             // short line under the name, SFW
  avatarInitials: string;      // fallback avatar text if no avatarUrl is set

  // Profile picture URL. Shown on the HUMAN page only (bot/crawler page always
  // uses initials, never this image). MUST be a hosted https URL — an uploaded
  // file has to live somewhere with a real link first (image host or R2).
  //
  // STRONG RECOMMENDATION: use a clean, SFW portrait here. This page is the
  // funnel page Meta's crawler and integrity systems inspect; a suggestive
  // image here works directly against the shadowban-avoidance this whole build
  // is for (on-page content signal — see ARCHITECTURE.md §1 mechanism #3/#4).
  avatarUrl: string;

  // Background media behind/above the card. HUMAN page only — the bot/crawler
  // page never renders any of this (always the plain gradient). backgroundUrl
  // may be an image or a video depending on backgroundMediaType.
  backgroundUrl?: string;
  backgroundType?: BackgroundType;         // default "none" (or "full" if a url is set pre-migration)
  backgroundMediaType?: BackgroundMediaType; // default "image"

  ogDescription: string;       // shown in Instagram/Meta link previews — keep generic, nothing that reads as the flagged category
  links: LinkItem[];
}

export const pageConfig: PageConfig = {
  modelName: "Ana",
  handle: "@examplecreator",
  tagline: "New drops every week — tap in below",
  avatarInitials: "M",

  // Served same-origin from the MEDIA bucket via /media/<key> (see handleMedia
  // in index.ts). Keep it same-origin: a cross-origin avatar host costs a fresh
  // DNS lookup + TLS handshake (~160ms on cellular) before the face can paint,
  // and this page's whole job is one fast tap.
  // Pre-sized to 288x288 (3x the 96px .avatar box) — do not point this at a
  // full-resolution photo. The original here was 1920x2560 / 412KB to fill a
  // 96px circle; resized + q80 it is ~20KB, a 95% cut with no visible change.
  avatarUrl: "/media/avatar-288.jpg",
  backgroundUrl: "",

  ogDescription: "Official links and updates.",

  links: [
    // Single card. No logoUrl, no icon, faviconFallback defaults to true ->
    // the logo is the the destination platform favicon, fetched server-side via /icon/vip.
    // The string "destination.example" never appears in any page HTML.
    { id: "vip", label: "VIP Access", url: "https://destination.example/creator", icon: "vip" },
  ],
};
