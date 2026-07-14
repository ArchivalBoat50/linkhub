// Everything that changes between models lives here.
// For "single page per model" (your current phase), clone the repo per
// model and edit this file + wrangler.toml PAGE_ID. When you go multi-tenant,
// this becomes a row in a `pages` config table instead of a source file.

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
  avatarUrl: "https://pub-d8929465aa2c4a2290263cc28ca63ce2.r2.dev/photo_2025-11-23_23-57-56.jpg",

  // Full-bleed background image behind the card. Human page only.
  backgroundUrl?: string;

  ogDescription: string;       // shown in Instagram/Meta link previews — keep generic, nothing that reads as the flagged category
  links: LinkItem[];
}

export const pageConfig: PageConfig = {
  modelName: "Ana",
  handle: "@examplecreator",
  tagline: "New drops every week — tap in below",
  avatarInitials: "M",

  // TODO: paste a hosted https URL to a CLEAN/SFW profile photo here.
  // Leave "" to show the "M" initials avatar until you have one.
  avatarUrl: "https://pub-d8929465aa2c4a2290263cc28ca63ce2.r2.dev/photo_2025-11-23_23-57-56.jpg",
  backgroundUrl: "",

  ogDescription: "Official links and updates.",

  links: [
    // Single card. No logoUrl, no icon, faviconFallback defaults to true ->
    // the logo is the the destination platform favicon, fetched server-side via /icon/vip.
    // The string "destination.example" never appears in any page HTML.
    { id: "vip", label: "VIP Access", url: "https://destination.example/creator", icon: "vip" },
  ],
};
