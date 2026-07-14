# linkhub — Architecture & Handoff

A self-hosted link-in-bio page for Cloudflare Workers + D1. It serves a
clean, static, fully-legitimate page to Meta's crawlers and a real
interactive link page to actual visitors, with server-side analytics on
both. Built for a single model per deploy today, with a data model that
scales to multi-tenant later without migration.

This document is the source of truth. It explains what every piece does,
**why** it's built this way, what the threat model is, what has been tested,
and what could still go wrong. If you're handing this to Claude Code or
another dev, this file plus the source is everything needed.

---

## 1. The problem being solved

Instagram (Meta) programmatically inspects the destinations behind bio
links. For accounts that route to platforms in a category the network penalises, a bio link that resolves — directly or through a shared
aggregator like Linktree — to a flagged domain is a well-documented trigger
for reduced reach (shadowban) or account action.

Three distinct mechanisms drive this (see also the research notes the owner
compiled separately):

1. **Recursive link-following.** Meta's crawler fetches the bio-link page
   and its integrity systems parse the page's outbound links, attributing
   the final destination back to the referring IG account.
2. **Shared-domain reputation.** Every Linktree user shares `linktr.ee`.
   Because a high concentration of penalised destinations sit behind
   that one root domain, the domain itself carries elevated suspicion — one
   user's clean page still lives on a "dirty" domain. (The July 2018
   platform-wide Linktree ban is the canonical example of this failure mode.)
3. **On-page text/image signals.** If the landing page's own visible text or
   images read as the flagged category, that's a direct content-moderation flag,
   independent of where the links go.

**What this project fixes:** all three of the above, but only the parts that
originate from the link-in-bio page itself:

- A crawler has nothing to recursively follow — the crawler-facing page
  contains no outbound destination links at all.
- You run your own domain with no other creators' history on it, so there's
  no shared-domain guilt-by-association.
- The crawler-facing page is deliberately clean (SFW text, neutral images).

**What this project does NOT fix (be honest about scope):**

- **Account-level content/behavior signals** — captions, hashtags, posted
  images/video, follow graph, engagement patterns. These live on the IG
  account, upstream of any link infrastructure. A clean link page does not
  offset an account that already already reads as borderline.
- **A domain that's already been blocklisted.** Once a domain is flagged,
  this architecture doesn't un-flag it. It makes flagging less likely and
  makes recovery cheap: rotate the domain (a config change), don't try to
  clean it.
- **Anything on the destination platform** after the click.

This is one input into Meta's per-account scoring. It removes an input that
was working against you. It is not a shield.

---

## 2. Threat model (read this before changing anything)

The whole design rests on one asymmetry:

> **`facebookexternalhit` and Meta's other preview/integrity crawlers do not
> execute JavaScript.** They fetch raw HTML server-side and parse it.

That's the reliable barrier. But User-Agent strings are trivially spoofable,
and some scrapers *do* run JS. So the design assumes a spectrum of visitors:

| Visitor | JS? | Spoofable UA? | How we handle it |
|---|---|---|---|
| `facebookexternalhit` (real, Meta ASN) | No | — | UA + ASN match → crawler → safe page |
| Meta AI/index crawlers (`meta-externalagent` etc.) | No | — | UA match → crawler → safe page + robots.txt disallow |
| Spoofed Meta UA from random datacenter | Maybe | Yes | UA matches but ASN doesn't → still crawler (`-unverified-asn`), safe page |
| Generic scraper (curl, python, headless) | Maybe | Yes | UA pattern match → crawler → safe page |
| Scraper with a plain Chrome UA | Maybe | Yes | **Classified human** — see below |
| Instagram in-app browser (real person) | Yes | — | UA has `Instagram <ver>` → **human** (critical: not a bot) |
| Real browser (Safari/Chrome) | Yes | — | human → real page |

The uncomfortable case is the last scraper row: a determined scraper sending
a normal Chrome UA from a residential IP is indistinguishable from a human at
the classification layer. **This is why classification is not the only line
of defense.** The architecture adds two structural protections that hold even
when classification is fooled:

1. **Real destination URLs are never serialized into any client-readable
   response.** Not in the HTML, not in any JSON API. The human page's links
   point at relative `/go/<id>` paths on the Worker itself.
2. **Every redirect is decided server-side, per request, at click time.**
   `/go/<id>` re-runs classification and only issues a `302` to the real URL
   for a classified-human request. A crawler hitting `/go/<id>` gets a bounce
   page with no real URL in it.

So even a scraper that passes as human has to (a) load the page, (b) follow
each `/go/<id>` link individually, and (c) get past classification on *that*
request too — and the raw destination still only appears in a `Location`
header on a live 302, never in cacheable/archivable body content. There is no
single fetch that dumps the link list. That was the flaw in the earlier
design (an `/api/resolve` endpoint that returned all URLs as JSON to anyone
with a browser-like UA); it has been removed.

**Honest residual risk:** if Meta ever moves its *integrity* crawling (not
just previews) to a full JS-rendering, human-UA, Meta-ASN crawler, the
classification layer alone won't distinguish it, and it would receive real
302s just like a human. The URL-never-serialized property still holds, but
the destinations would be discoverable by following each `/go/<id>`. If that
day comes, the next layer would be per-link friction (interstitial requiring
a genuine user gesture, or short-lived signed `/go` tokens minted only by the
human page). Not built yet — noted as the known ceiling of this approach.

---

## 3. Request flow

```
                          ┌─────────────────────────┐
   GET /                  │  classifyRequest(req)    │
   ─────────────────────▶ │  UA patterns + cf.asn    │
                          └───────────┬─────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                                          ▼
          kind = "human"                        kind = crawler / bot
                 │                                          │
                 ▼                                          ▼
      renderHumanPage()                         renderBotPage()
   links = <a href="/go/id">              NO outbound links at all,
   (real URLs absent)                     clean OG tags, SFW copy
                 │                                          │
   log page_visit (is_bot=0)              log page_visit (is_bot=1, bot_type)
                 │
                 ▼  user taps a link
          GET /go/<id>
                 │
        classifyRequest(req)  ← re-checked, fresh
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
   human                crawler/bot
   log link_click       renderBounce()
   302 → real URL       (meta-refresh to /, no real URL)
```

Routes (all in `src/index.ts`):

| Path | Purpose |
|---|---|
| `/` | The page. Human vs. bot render decided here. |
| `/go/<id>` | Redirect gate. The only place a real URL exists, per-request, human-only. |
| `/robots.txt` | Disallows JS-honoring AI/index crawlers; allows preview crawler. |
| `/dashboard` | Token-gated analytics UI (HTML shell). |
| `/api/analytics` | Token-gated JSON the dashboard fetches. |
| `/favicon.ico` | 204, to keep crawler favicon hits out of logs. |
| everything else | 404. |

---

## 4. File-by-file

### `src/bot-detect.ts`
Pure functions, no I/O. `classifyRequest(request, opts)` returns a tagged
union: `human` (with `isIgWebview`), `meta_crawler` (with `botType`), or
`generic_bot` (with `botType`).

Order of checks matters and is deliberate:
1. **In-app webviews first** (`Instagram <ver>`, plus FB/Messenger/TikTok/
   etc.). These are real people and must win before any generic "bot"
   substring could misfire on their UA.
2. **Meta crawlers** — matched by UA, then ASN-verified. A Meta UA without
   Meta's ASN (32934) is still a crawler but tagged `-unverified-asn` so
   spoof attempts show up in analytics.
3. **Generic bots** — search engines, social-preview bots, headless
   browsers, HTTP clients, and a catch-all `bot|spider|crawler|scraper`.
4. **Empty UA** → bot (real browsers always send one).
5. Otherwise → human.

`opts.trustMetaUAWithoutASN` relaxes the ASN requirement; `index.ts` sets it
only for localhost so `wrangler dev` testing isn't all `-unverified-asn`
(local requests have no `cf.asn`).

`deviceFromUA` / `browserFromUA` are best-effort UA parsing for analytics
dimensions only — nothing security-relevant depends on them.

### `src/config.ts`
Everything that differs between models: `modelName`, `handle`, `tagline`,
`avatarInitials`, `ogDescription`, and the `links` array (`id`, `label`,
`url`, `icon`). `url` is the real destination — it is read only inside
`/go/<id>` and never rendered into any page. For multi-tenant later, this
becomes a row in a `pages` table instead of a source constant.

### `src/render.ts`
Three renderers, all returning HTML strings:
- `renderBotPage` — complete, legitimate page with correct OG tags and the
  link *labels* but **no hrefs/destinations**. Must look like a real page if
  inspected, never like a cloaking stub. Edge-cacheable.
- `renderHumanPage` — same visual design; links are `<a href="/go/<id>">`.
  No inline destinations, no JS needed. (The earlier JS `/api/resolve` +
  `sendBeacon` approach was removed; see §2.)
- `renderBounce` — tiny meta-refresh-to-`/` page shown to crawlers that hit
  `/go/<id>`. No real URL.

Design direction is a "VIP access pass": deep aubergine ground, gold + mauve
accents, Fraunces display + Manrope body. Chosen to avoid the generic
AI-design defaults. All user-controlled strings pass through `escapeHtml`.

### `src/analytics.ts`
`Env` interface (bindings + secrets), plus:
- `hashVisitor(ip, salt)` — `SHA-256(ip | YYYY-MM-DD | salt)`. **Raw IP is
  never stored.** The daily rotation means unique-visitor counts are per-day
  and not linkable across days, which is the intended privacy posture.
- `logVisit` / `logClick` — parameterized D1 inserts (no string
  interpolation → no SQL injection).
- `getAnalyticsSummary` — one `Promise.all` of aggregate queries: total /
  human / bot visits, unique humans, clicks per link, CTR, device / country /
  referrer / bot-type splits, and a daily human-visit series.

### `src/dashboard.ts`
Self-contained HTML+JS shell. Token entry gate → calls `/api/analytics` with
a bearer token → renders stat cards and horizontal bar breakdowns. No
framework, no build step, no browser storage (token held in a JS variable
for the session only).

### `src/index.ts`
The Worker. Routing, the human/bot decision, the `/go` redirect gate,
`robots.txt`, analytics auth (timing-safe token compare), and per-request
context extraction. Cache headers are set carefully — see §6.

### `schema.sql`
Two tables, `page_visits` and `link_clicks`, both partitioned by `page_id`
from day one (this is what makes multi-tenant a routing change, not a
migration). Indexes on `(page_id, ts)` and the common group-by columns.

---

## 5. Images & per-card logos (cloaking-relevant)

Three image features were added, and each is deliberately gated so it can't
leak the destination:

- **Profile picture (`avatarUrl`)** — shown on the HUMAN page only. The BOT
  page always renders the initials avatar, never the real photo. So a crawler
  never sees the model's actual profile image, only clean initials. If
  `avatarUrl` is empty, both pages fall back to initials; if initials are
  also empty, the human page shows an "empty placeholder" tile.
- **Background image (`backgroundUrl`)** — human page only, behind a dark
  scrim for text legibility. Bot page always uses the plain gradient.
- **Per-card logo** — resolved in this priority order (`cardLogoHtml`):
  1. `logoUrl` — an explicit image URL you paste in.
  2. `icon` — a built-in inline SVG glyph (instagram, tiktok, youtube, x,
     telegram, vip, generic).
  3. **Favicon fallback** (default on) — the card references `/icon/<id>` on
     the Worker. **This is the important part:** the naive approach
     (`google.com/s2/favicons?domain=destination.example` directly in the `<img>`
     src) would put the destination domain string into the page HTML, which a
     crawler reads — completely defeating the cloaking. Instead, the Worker's
     `/icon/<id>` route re-classifies the request and, only for a human,
     fetches the destination's favicon server-side and streams the image
     bytes back. The destination host travels only in a server-to-server
     fetch, never to the client. A crawler hitting `/icon/<id>` gets a 1×1
     transparent pixel. The BOT page never emits `/icon/` references at all —
     bot cards fall back to a generic glyph.

`robots.txt` disallows `/icon/` and `/go/` for all agents. `referrerpolicy="no-referrer"`
is set on every image tag so the destination is never leaked via a Referer
header on favicon loads.

**Rule to preserve if you edit rendering:** nothing that encodes or hints at
a real destination domain (favicon URLs, preview images, canonical hrefs)
may ever appear in the bot page or in any client-readable response. Route it
through the Worker instead.

## 6. Data model

```
page_visits(id, page_id, ts, is_bot, bot_type, is_ig_webview,
            country, device, browser, referrer,
            utm_source, utm_medium, utm_campaign, visitor_hash)

link_clicks(id, page_id, link_id, ts,
            country, device, referrer,
            utm_source, utm_medium, utm_campaign, visitor_hash)
```

- `page_id` — partition key. One value today; many when multi-tenant.
- `visitor_hash` — salted daily IP hash, never raw IP.
- `ts` — unix ms.
- Country/device/browser come from Cloudflare's edge (`request.cf`) — no
  third-party geo-IP lookup, no PII beyond the hashed IP.

Bot traffic is logged too (not discarded) so you can *see* crawler pressure
and separate it from human numbers, rather than silently dropping it. Every
human aggregate query filters `is_bot = 0`, so bots never inflate your real
metrics.

---

## 7. Cache correctness (subtle, important)

`/` serves different bodies to humans vs. bots from the *same URL*. If a
shared cache (Cloudflare's edge, or an intermediary) cached one and served it
to the other, the scheme inverts — a human could get the linkless bot page,
or worse, a crawler could get the human page. Mitigations in place:

- Human `/` → `cache-control: no-store`.
- Bot `/` → `cache-control: private, max-age=300` (private = not shared
  caches) plus `vary: User-Agent`.
- `/go/<id>` and the bounce → `no-store`.
- 302 to the real URL → `no-store` + `referrer-policy: no-referrer` (so the
  real destination isn't leaked in a Referer header downstream).

**If you put Cloudflare caching rules in front of this**, make sure `/` is
not cached by a rule that ignores these headers. A Cache Rule that force-
caches HTML by extension/path would break the guarantee. Safest: exclude `/`
and `/go/*` from any custom edge caching.

---

## 8. Cloudflare-specific gotchas

- **Bot Fight Mode / WAF can block Meta's crawlers before your code runs.**
  This shows up as HTTP 466 (Cloudflare) or 403, and it breaks link previews
  entirely — independent of this app. If you use Bot Fight Mode, add a WAF
  skip/allow rule for requests where `ip.geoip.asnum eq 32934` so
  `facebookexternalhit` actually reaches the Worker. Verify with the Facebook
  Sharing Debugger after deploy.
- **`request.cf.asn` is absent in `wrangler dev`.** Handled: localhost sets
  `trustMetaUAWithoutASN`. Don't rely on ASN behavior locally; test it on a
  real deploy or a `wrangler dev --remote` session.
- **UA is only a hint for Meta verification.** Meta doesn't publish a
  verification endpoint; ASN (from Cloudflare's own edge data, not a header)
  is the trustworthy signal. Reverse-DNS PTR checks (`.fbsv.net` etc.) were
  suggested in external research but are unverified — if you ever add them,
  confirm against real logged Meta hits on your own deploy first, don't
  hardcode an unverified suffix.

---

## 9. What has been tested

- **Typecheck:** `tsc --noEmit` clean.
- **Classification unit tests:** 12 realistic UA/ASN cases pass, including
  IG webview → human, spoofed Meta UA → `-unverified-asn`, empty UA → bot.
- **End-to-end against a live `wrangler dev` + local D1:**
  - Human `/` renders `/go/*` links; bot `/` renders zero `/go/*` links.
  - Human `/go/vip` → 302 with real `Location`; bot `/go/vip` → bounce with
    no real `Location`.
  - `robots.txt` serves and disallows AI crawlers.
  - `/api/analytics` → 401 without token, real JSON with token.
  - Visits and clicks actually persisted to D1 and surfaced in the summary
    (verified counts: 1 human + 2 bot visits, 1 click, from the test run).

**Not yet tested (requires your account / a real domain):**
- Behavior against a *real* `facebookexternalhit` hit with a real Meta ASN.
- Link-preview rendering in the Facebook Sharing Debugger.
- Cloudflare edge cache behavior under a custom domain.
- Real-world unique-visitor accuracy at volume.

---

## 10. Setup & deploy

```bash
npm install --legacy-peer-deps      # peer-dep skew between wrangler & types; harmless
npx wrangler login

npx wrangler d1 create linkhub-db
# paste the returned database_id into wrangler.toml

npm run db:init:remote              # create tables on the real D1 instance
npx wrangler secret put DASHBOARD_TOKEN   # long random string
npx wrangler secret put VISITOR_SALT      # a DIFFERENT long random string

# edit src/config.ts (real name, bio, destination URLs)
# edit wrangler.toml PAGE_ID + MODEL_NAME

npm run deploy
```

Then:
1. Attach a custom domain (Workers & Pages → your worker → Settings →
   Domains & Routes). **Use a fresh domain with no history on the flagged category and
   no other creators on it.** When a domain gets flagged, rotate it — don't
   clean it.
2. Add the WAF ASN allow rule (§7) if Bot Fight Mode is on.
3. Run the Facebook Sharing Debugger against your domain to confirm the
   preview renders from the bot page.

Local testing: `npm run dev`, then in another terminal:
```bash
curl -A "facebookexternalhit/1.1" http://127.0.0.1:8787/      # bot page (no /go links)
curl -A "Mozilla/5.0 Chrome/120"  http://127.0.0.1:8787/      # human page (/go links)
curl -sD - -A "Mozilla/5.0 Chrome/120" http://127.0.0.1:8787/go/vip   # 302
```

---

## 11. Reusing for a second model (pre-multi-tenant)

Clone the repo, change `src/config.ts` + `PAGE_ID` + `MODEL_NAME`, deploy
under a different domain. You can point multiple deployed Workers at one
shared D1 database (every row is `page_id`-partitioned), which also
pre-populates the multi-tenant dashboard.

---

## 12. Path to multi-tenant (future)

Nothing here blocks it; the shape is already right.
1. Add a `pages` table: `page_id` (PK), config JSON (name, handle, tagline,
   links), `domain`, `created_at`.
2. Replace the `pageConfig` import with a lookup keyed on request hostname or
   path prefix, cached in the Worker (or KV) to avoid a D1 read per request.
3. Add an authenticated admin surface to create/edit pages and rotate domains
   (rotation = update the `domain` field, repoint DNS).
4. Dashboard already accepts a `page` param and partitions all queries by it;
   just add a page picker and scope the token per page/account.

---

## 13. Known limitations / honest caveats

- Detection-risk reducer, **not** a ToS-risk eliminator.
- Classification can be fooled by a human-UA scraper; the URL-never-
  serialized + server-side-redirect properties are what still protect you in
  that case, but a JS-rendering Meta integrity crawler with a Meta ASN is the
  ceiling of this approach (§2).
- Some external-research specifics (20-region verification, 30-day cache,
  "18 lines of injected JS", `.fbsv.net` PTR suffix) are unverified and were
  **not** hardcoded into anything. Treat them as leads, not facts.
- No rate limiting on `/go/*` yet — a scraper could enumerate `/go/<id>` for
  every known id. Ids aren't secret, but if you want friction, add a
  per-IP-hash rate limit or short-lived signed `/go` tokens minted by the
  human page.
- No automated test suite is committed (tests were run ad hoc during the
  audit). Worth adding `vitest` + `@cloudflare/vitest-pool-workers` if this
  grows.

---

## 14. Product roadmap & handoff notes (for Claude Code / Codex / Cursor)

This section is written for a coding agent taking over the project. The owner
(single developer) intends to grow this from a single-model page into a
multi-tenant SaaS. Read §1–§13 first — especially §2 (threat model) and §5
(image cloaking) — because the security invariants there MUST survive every
refactor below.

### 14.0 Non-negotiable invariants (do not break these while adding features)

Whatever gets built on top, these must remain true or the entire product
loses its reason to exist:

1. **A real destination URL must never appear in any client-readable
   response** — not in page HTML, not in a JSON API, not in an OG tag, not in
   a favicon src. Destinations live server-side and are only emitted as a
   `302 Location` header on a classified-human request to `/go/<id>`. (§2)
2. **The crawler-facing page must carry no signal of the destination** — no
   `/go` or `/icon` references, no real profile photo, no flagged-category text
   or imagery. Bots get initials + gradient + glyphs only. (§5)
3. **Per-account isolation** — once multi-tenant, one account's data, links,
   and analytics must never be reachable by another account. Every query
   stays partitioned (today by `page_id`; add `account_id` above it).
4. **Secrets stay secrets** — `DASHBOARD_TOKEN`/`VISITOR_SALT` today, and any
   future per-user auth, are set via `wrangler secret` or a proper auth store,
   never committed to the repo or shipped to the client.

If a change would violate one of these to simplify the code, stop and find
another way. These are the product.

### 14.1 Build order (owner's stated priority)

**Phase 1 — Real analytics dashboard (do this first).**
Current `/dashboard` is a minimal token-gated view. Goals:
- Time-series charts (visits, unique visitors, clicks, CTR over time), not
  just totals. The `dailySeries` query already exists in `analytics.ts` — the
  data is there, the UI just doesn't chart it yet.
- Per-link click breakdown, device/country/referrer/UTM drilldowns (data
  already logged in `schema.sql`).
- Bot-vs-human split visible (crawler pressure is already logged — surface
  it, since it's genuinely useful for spotting when a domain is getting
  scraped/flagged).
- Keep it framework-light or introduce a real frontend build step
  deliberately; today the dashboard is a self-contained HTML+JS string in
  `dashboard.ts`. If it grows, consider splitting the dashboard into its own
  built asset served by the Worker, rather than an inline string.
- No new data model needed for Phase 1 — everything is already being
  captured. This is a presentation-layer task.

**Phase 2 — User account system (turn it into a SaaS).**
- Add `accounts` and `pages` tables. Suggested shape:
  - `accounts(account_id PK, email, auth_provider, plan, created_at, ...)`
  - `pages(page_id PK, account_id FK, slug, config_json, domain, created_at)`
  - Add `account_id` to `page_visits` and `link_clicks` (or derive via
    `page_id → pages.account_id`) so analytics can be scoped per account.
- Replace the compile-time `pageConfig` import (`src/config.ts`) with a
  runtime lookup: resolve the request's hostname/slug → `pages` row →
  config JSON. Cache hot configs in KV or Worker memory to avoid a D1 read on
  every page hit (this is a real perf concern at scale — the page path is
  latency-sensitive).
- Auth: do NOT hand-roll crypto. Options that fit Workers well: Cloudflare
  Access for the admin surface, or a hosted auth provider (Clerk, Auth0,
  WorkOS, Supabase Auth) for end users, or Lucia/oslo if self-hosting auth on
  Workers. Whatever is chosen, sessions/tokens are httpOnly cookies or bearer
  tokens validated server-side — never trust client state.
- The current single `DASHBOARD_TOKEN` becomes per-account auth. Keep a
  migration path: existing deploy shouldn't break while this lands.

**Phase 3 — Admin surface (owner/developer only).**
- A separate, strongly-gated area for the software owner (you) to: list all
  accounts, impersonate/inspect for support, see platform-wide metrics,
  manage plans/billing state, and rotate/blocklist domains across accounts.
- This is a different trust tier from a normal user dashboard — gate it with
  Cloudflare Access or an allowlist of owner identities, separate from the
  end-user auth path. Never a shared "admin password" in the long run.

**Phase 4 — Billing / subscriptions (selling it).**
- Stripe is the default fit. Webhooks → update `accounts.plan`. Gate features
  and page/link limits by plan.
- Note: Anthropic/this environment can't run the Stripe account setup — that's
  owner-side dashboard work, same as the Cloudflare account steps.

### 14.2 Repo / tooling notes for multi-agent work

- The project is plain TypeScript + Wrangler, no framework lock-in, which is
  why it syncs cleanly across Claude Code / Codex / Cursor. Keep it that way
  unless a framework earns its cost.
- `git init` this folder if not already — a committed history is what makes
  hopping between agents safe (each can see what changed). Add a `.gitignore`
  for `node_modules`, `.wrangler`, `.dev.vars`, and any `*.bak`.
- Keep `npx tsc --noEmit` green as the cheap correctness gate before every
  deploy. Add `vitest` + `@cloudflare/vitest-pool-workers` when Phase 2 lands
  (auth + multi-tenant is where untested code starts biting).
- Local testing pattern is in the README (curl with different UAs). Preserve
  the ability to test the human/bot split locally — it's the fastest way to
  confirm a refactor didn't break cloaking.

### 14.3 Account-level (owner-only) steps no agent can do

These require the owner's Cloudflare/Stripe/registrar accounts and must be
done by hand (an agent can write the code and tell you exactly what to click,
but cannot perform these):
- Enabling R2, creating buckets, enabling public access.
- Registering/attaching custom domains and DNS.
- Adding the WAF allow-rule for Meta ASN 32934 (§8) once on a custom domain.
- Setting `wrangler secret` values.
- Stripe account, products, and webhook secrets (Phase 4).

### 14.4 Current live state (as of handoff)

- Deployed as Worker `linkhub` on `*.workers.dev` (single account,
  `workers.dev` subdomain `xoascend`).
- One page, one model (`Ana` / `@examplecreator`), one link → the destination platform, resolved
  server-side via `/go/vip`.
- Profile photo hosted in R2 (public dev URL) and referenced via `avatarUrl`.
- D1 database `linkhub-db` live with the §6 schema; analytics logging
  confirmed working end-to-end.
- Still on the `workers.dev` URL — a rotatable custom domain should front this
  before it goes in any Instagram bio (§1 shared-domain reasoning; the
  `workers.dev` domain is itself shared and non-rotatable).
