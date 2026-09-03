# linkhub — Architecture & Handoff

A self-hosted link-in-bio page for Cloudflare Workers + D1. It serves a
clean, static, fully-legitimate page to Meta's crawlers and a real
interactive link page to actual visitors, with server-side analytics on
both. Built for a single model per deploy today, with a data model that
scales to multi-tenant later without migration.

This document is the source of truth. It explains what every piece does,
**why** it's built this way, how requests are classified, what has been tested,
and what could still go wrong. If you're handing this to Claude Code or
another dev, this file plus the source is everything needed.

---

## 1. The problem being solved

A link-in-bio page is a public URL fetched by everything: Meta's link-preview
and crawler agents (`facebookexternalhit`, `meta-externalagent`), generic
scrapers, link-checkers, and people. Two properties of the hosted aggregators
follow from that:

1. **Every destination is in the HTML.** A hosted aggregator serialises each
   outbound URL into the page body, so any fetch — by anything, at any time —
   returns the full list of where the links go. No classification happens; the
   page has one body and it tells everyone the same thing.
2. **The domain is shared.** Every Linktree user is on `linktr.ee`. Reputation
   attached to that root domain is reputation you did not create and cannot
   influence.

**What this project does:** replaces that page with a self-hosted Worker on
your own domain that classifies each request and serves a body appropriate to
it.

- A crawler has nothing to follow — the crawler-facing page contains no
  outbound destination links at all.
- Destinations are resolved server-side per request and emitted only as a
  `302 Location` header to a request classified as human.
- The domain is yours, so its reputation is yours.

**Scope.** This is link infrastructure. It controls what a fetch of the page
reveals, and nothing else. It says nothing about, and does nothing for, the
account that links to it or the platform on the far side of the click.

---

## 2. Request classification model (read this before changing anything)

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

### HTTPS is forced in the Worker (do not remove)

`http://` is 301'd to `https://` ahead of all routing (localhost exempt, so
`wrangler dev` still works). This is **not** hygiene — until 2026-07-23 real
traffic was arriving in cleartext, because Instagram stores bio links without a
scheme and opens them over `http://`, and the zone had no HTTPS redirect. It
was found in the logs, not by inspection: the `Referer` on every recorded
mobile tap read `http://example-links.com/`.

The reason it matters is classification-level, not cosmetic: **the 302 carrying
the real destination was travelling unencrypted**, which hands the account →
destination association to any observer on the network path — exactly the link
this design exists to conceal. It also made `og:url` advertise `http://` to
Meta's crawler, and left `location.origin` as `http:`, so the early iOS escape
attempts were building `x-safari-http://` URLs — one reason the first three
failed, though that whole browser-scheme approach was itself the wrong tool
(the working mechanism is `instagram://extbrowser`, see §3.5 below).

Anything that builds an absolute URL for a client to act on must **pin
`https://` explicitly** rather than trusting how the request arrived.

### Breaking out of the in-app browser (`androidEscape()` + `IOS_ESCAPE_SCRIPT`)

> **TL;DR — iOS uses `instagram://extbrowser`, Instagram's own "open in the
> default browser" deeplink; Android uses `intent://`. Not a browser scheme.
> See "The mechanism" and the investigation log below.**

~All traffic arrives inside Instagram's in-app WebView, and a webview session
starts logged-out every time — no saved login for the destination, no password autofill,
no Apple/Google Pay. So a classified-human tap is handed to the device's real
browser instead of redirecting inside the webview.

**This does not weaken invariant #1.** The escape URL points at our own
`/go/<id>`, *never* at the destination. The real browser re-requests that URL
and takes the ordinary 302 from there, so the real destination still appears
in exactly one place — the `Location` header of a classified-human 302 — and
never inside an intent URI, a custom-scheme string, or an HTML body.

#### The mechanism (`instagram://extbrowser`)

The iOS escape is **Instagram's own private deeplink**, not a browser scheme:

```
instagram://extbrowser/?url=<the https URL, percent-encoded>
```

`instagram://` is answered by the Instagram app that is *hosting the webview*,
and `extbrowser` is its internal command "open this URL in the device's DEFAULT
browser" (Safari for most people). Because it targets the app's own scheme
rather than a browser's, **iOS does not gesture-gate it** — it fires on page
load with no tap, and needs no particular browser installed. That is the whole
reason it succeeds where browser schemes fail.

Confirmed on iPhone 17 Pro Max / iOS 26: lands in Safari. It is also exactly
what a live competitor in this niche serves (see the investigation log below).

> **Do not "simplify" this to a browser scheme.** `x-safari-https://`,
> `com-apple-mobilesafari-tab://`, and `googlechrome://` were all tried and are
> the wrong tool — see below. The path to the browser runs *through Instagram*,
> not around it.

#### As built

- **Android** — a 302 to an `intent://` URI (server-side, in `androidEscape()`).
  No JS, no added latency. Deliberately **no `package=`**, so the system
  resolves it with the user's *default* browser instead of forcing Chrome.
  Because the intent targets our own domain, no app holds an app-link claim on
  it, so there's no chooser dialog and no bounce back into Instagram;
  `S.browser_fallback_url` returns to the normal path if nothing can handle it.
  **Untested on real hardware.** (Note: the competitor forces Chrome here via
  `package=com.android.chrome`; we chose the default browser instead, matching
  the stated goal — revisit if default-browser resolution proves flaky.)
- **iOS, on load** — fires `instagram://extbrowser` for the current URL, moving
  the *whole page* to the default browser so even the bio-link tap escapes, not
  just a card tap. No fallback needed: if it somehow doesn't fire, the visitor
  stays on the page already in front of them. `sessionStorage`-guarded so
  returning to the Instagram tab doesn't relaunch it; the reopened URL carries
  `x=1` so `handleIndex` doesn't double-count the visit.
- **iOS, on card tap** — a safety net for the rare case the load-time escape
  didn't run (e.g. `sessionStorage` blocked). Fires `instagram://extbrowser`
  for the specific `/go/<id>` (carrying `b=i`); a 1.5 s timer falls through to
  the ordinary in-webview `/go` redirect (`e=to`) if nothing happens, cancelled
  on `visibilitychange`/`pagehide` so a successful escape doesn't also fire it.
  **A refused escape must never cost the click.**
- The script is served **only** to iOS **Instagram** webview visitors — gated on
  the IG webview specifically, because only the Instagram app answers this
  deeplink. Never on the bot page; the real browser is not an IG webview, so it
  never receives it: no loop is possible.

#### Request markers — get these wrong and analytics break silently

The two platforms escape at *different points*, so "one tap, one row" needs care:

| Marker | Meaning | Logs a click? |
| --- | --- | --- |
| `b=a` | Android; escaped server-side, webview hop already logged | **no** — would double-count |
| `b=i` | iOS; escaped on the page, webview never reached the server | **yes** — the only record of the tap |
| `e=to` | iOS; escape refused, fallback timer fired | **yes** — this request *is* the tap |
| `x=1` | page re-opening in the default browser after the load-time escape | suppresses the duplicate `page_visit` |

An earlier revision suppressed logging on *every* escape hop — correct for
Android, wrong for iOS. Shipped with a working escape it would have dropped
every escaped click from analytics, so the feature working would have looked
exactly like traffic collapsing.

#### Investigation log — how this was actually found (2026-07-23 → 24)

Kept deliberately, because the *wrong turns* are the most useful part: the
failure mode here was **reasoning about schemes instead of reading a working
example**, and it cost four test cycles on a real handset before the answer
turned out to be one HTTP fetch away.

1. **First three iOS attempts, all `x-safari-https://`, all failed.** Tried on
   page load (no gesture), then from a click handler (real gesture), then as a
   native anchor-href swap. Every one opened inside Instagram anyway. Wrong
   conclusion drawn at the time: "iOS gesture-gates the scheme."
2. **A cleartext bug was masking the signal.** The page was being served over
   plain `http://` (Instagram opens bio links without a scheme; the zone had no
   HTTPS redirect), so `location.origin` was `http:` and the escapes were
   building `x-safari-**http**://`. Fixed by forcing HTTPS (§ above) — a real
   classification hole in its own right — but the escape *still* failed once the
   URL was clean, which finally ruled the scheme itself out.
3. **Stopped guessing, built a probe.** A page (`/escape-test`) fired every
   candidate scheme at a URL on our own domain and let a working one *record its
   own success* — the escaping browser arrives with its own User-Agent, and that
   arrival is proof. Result on the owner's phone: `googlechrome://` /
   `googlechromes://` **worked** (arrived as `CriOS`); `x-safari-https://` and
   `com-apple-mobilesafari-tab://` got nothing. Shipped Chrome as the escape and
   wrote down "Safari cannot be targeted." **That conclusion was wrong** — the
   probe could only test schemes already thought of, and the right one wasn't
   among them.
4. **The owner insisted the reference profile had opened *Safari*, not Chrome,**
   and later recalled the link: `clickylo.co`. That was the unlock.
5. **Read the competitor instead of reasoning.** `clickylo.co` was a funnel
   front; `/claim` redirected to **`slt.bio`** (a mature service in exactly this
   niche — "Deeplink Auto: tap from Instagram, land in Safari"). Its bundles
   referenced a deeplink domain, **`igpopl.ink`**. Fetching `igpopl.ink/<slug>`
   **with an iPhone + Instagram User-Agent** returned a 347-byte page whose
   entire body was the escape: `instagram://extbrowser/?url=…` for iOS, an
   `intent://` variant for Android. The answer was sitting in the response.
6. **Swapped our scheme to `instagram://extbrowser`.** Owner confirmed it lands
   in Safari. One-line change in effect; four cycles of guessing avoided if the
   competitor's page had been read on day one.

**Lesson worth keeping:** when a behaviour is demonstrably possible in the wild,
fetch the working example with the right User-Agent and read it, before
theorising about what *should* work. A live competitor's client-side code is
public and often contains the whole answer verbatim.

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
  No inline destinations. (The earlier JS `/api/resolve` + `sendBeacon`
  approach was removed; see §2.) Carries `TAP_FEEDBACK_SCRIPT` — a ~0.5KB
  press state + progress bar on the cards, added 2026-08-01. Navigation still
  works without it: the card is a plain `<a>` and the script only adds classes,
  so a JS failure costs the animation, never the click.
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
  referrer / bot-type splits, and a daily human-visit series. Also `igCtr` and
  `ctrByDevice`, which are the metrics to actually judge the page on — see
  §6.1 for why the blended `clickThroughRate` misleads.

### `src/dashboard.ts`
Self-contained HTML+JS shell. Token entry gate → calls `/api/analytics` with
a bearer token → renders stat cards and horizontal bar breakdowns. No
framework, no build step, no browser storage (token held in a JS variable
for the session only).

The stat row is a CSS **grid** (`repeat(auto-fit, minmax(140px, 1fr))`), not
the flex `.row` used elsewhere. With flex, a tile that wrapped to a second
line kept `flex: 1` and stretched to full width — at six tiles on a narrow
viewport the last one became a lone full-width slab. `tsc` cannot see this
class of bug; the dashboard needs a real browser before shipping (§9).

### `src/index.ts`
The Worker. Routing, the human/bot decision, the `/go` redirect gate,
`robots.txt`, `/optout` (own-device exclusion, §6.3), analytics auth
(timing-safe token compare), and per-request context extraction. Cache headers
are set carefully — see §6.

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

### 6.1 Reading the funnel honestly (metric definitions)

**Do not judge the page on `clickThroughRate`.** It is `totalClicks ÷
humanVisits` across *all* human traffic, and on 2026-07-25 that blend read
6.6% while the audience it exists to measure was converting at ~32%. The gap
was entirely denominator composition, in two layers:

1. **Desktop traffic swamps it.** 612 of 936 human visits were desktop, 423 of
   those no-referrer Chrome. On an Instagram bio link that mix is inverted
   from what the traffic source implies, and it converted at 4.4% against
   mobile's 10.7%. Whatever it is (scanners, previewers, scrapers that clear
   `bot-detect.ts`), it is two thirds of the divisor and none of the audience.
2. **Own-device test traffic.** Escape testing means hammering the live page
   from a real phone, and those hits land in the same tables. One visitor
   logged **59 visits in 13 minutes**; three test hashes accounted for 98
   visits and 18 clicks, which pushed `igSharePct` to 10.8% when the true
   figure was 2.2%.

Prefer these, added 2026-07-25:

- **`igCtr` / `igVisits` / `igClicks`** — clicks from visitors whose visit that
  day came through the Instagram webview. The one number that answers "do
  people who arrive from the bio link tap the card". Attribution is by
  `visitor_hash`, which is stable *within* a UTC day (see the caveat below), so
  a visitor who lands before midnight and taps after is missed. At current
  volume that is rarer than the distortion it removes.
- **`ctrByDevice`** — `[{device, visits, clicks, ctr}]`, a `LEFT JOIN` so a
  segment with visits and zero clicks still appears (as 0%) instead of
  vanishing from the list.

`clickThroughRate` is retained in the API payload for back-compat, but as of
2026-08-01 it no longer renders anywhere on the dashboard — see below.

#### The 2026-08-01 pass: a click count that was 36% not-clicks

Auditing the 70 production `link_clicks` rows to explain "why only 26 clicks"
turned up three separate reasons the number was wrong, in both directions.

**1. `via` — taps vs. bare fetches.** 25 of 70 rows carried no `Referer` and
no UTM: a direct request for `/go/vip` by something that never had the page
open. The page sets no `referrer-policy`, so a genuine card tap is a
same-origin navigation that *always* sends one. The one honest exception is
the iOS escape hop, which Safari opens as a fresh navigation with no Referer —
so the check is `b=i` first, Referer second. That ambiguity was resolved
empirically before writing the rule: **zero** of the 25 belonged to a visitor
with an Instagram webview visit that day, so none were escape hops.
`link_clicks.via` is now `'page' | 'escape' | 'direct'`; only the first two
count as taps. Backfilled by `migrations/0001-click-provenance.sql` (45 taps,
25 direct, no NULLs left).

**2. Double-logged iOS taps.** The card-tap escape arms a 1500ms fallback
timer and both hops log by design (§3) — so a successful escape that doesn't
hide the webview in time writes *two* rows for one tap. Two pairs, 1.7s and
3.7s apart, were found in production. Fixed on both sides: the timer re-checks
`document.hidden` at fire time, and `logClick()` drops a repeat of the same
`(page_id, link_id, visitor_hash)` inside 10s. 10s and not 60s because
`visitor_hash` folds in the IP and carrier CGNAT puts many real people behind
one mobile IP — see §6.2.

**3. The denominator was mostly scanners.** 1002 of 1253 human visits carried
no referrer *and* no UTM; 838 were desktop against 414 mobile, on a bio link
that is mobile-only; the geography skewed SG 176 / NL 57 / CN 33 / HK 15. So:

- **`attributedVisits`** — human visits with a UTM or a recognised platform
  referrer. **`unattributedVisits`** is the remainder, reported as a
  diagnostic, never as a denominator.
- **`attributedClicks` / `attributedCtr`** — taps by visitors *in that same
  cohort*, matched by `visitor_hash` exactly as `igCtr` does. The cohort join
  is not optional: the first cut of this divided all taps by attributed visits
  and produced a **desktop CTR of 160%**, because desktop taps came
  overwhelmingly from visitors whose arrival was never attributed. A rate whose
  two sides describe different populations is not a rate.
- `ctrByDevice` and `dailySeries.ctr` use the same cohort-matched pair.

**Windows are day-aligned.** `windowStart()` returns UTC midnight of
`(today - days + 1)`, so "last 7 days" is seven whole calendar days ending
today. The old rolling `now - 7*86400` landed mid-day: the oldest bucket in
every chart was a partial day drawn as a full one, and the same question asked
twice in one afternoon gave two different totals.

**Dashboard.** Headline tiles are now IG tap rate, CTR attributed, link taps,
attributed visits, unique visitors — one population throughout. Raw visits,
unattributed visits, direct fetches and crawler hits moved to a *Traffic
quality* panel that states why each is excluded. In the traffic chart, raw
visits and crawler hits default to hidden (`s.off`): they are an order of
magnitude larger and flattened the two signal series onto the zero line —
caught by rendering it, not by typechecking it.

### 6.2 `visitor_hash` is IP + day — what that costs you

`hashVisitor()` is `SHA-256(ip | YYYY-MM-DD | salt)`. Two consequences bite
whenever you analyse this data, and both were hit on 2026-07-25:

- **It rotates at midnight UTC.** So a persistent "ignore this visitor" list
  keyed on `visitor_hash` cannot work — the key is gone within a day. This is
  why own-device exclusion is a cookie (§6.3) and not a blocklist.
- **It collapses every device behind one IP.** A laptop and a phone on the
  same home Wi-Fi share a hash for that day. Grouping by `visitor_hash` and
  selecting a non-aggregated `device`/`browser` returns an arbitrary row from
  the group, which will misdescribe a mixed-device hash — read those columns
  with `GROUP BY device, browser` or not at all.

Both properties are deliberate privacy posture (§4 `analytics.ts`), not
defects. They just make `visitor_hash` a weak identity, so treat per-visitor
conclusions drawn from it as directional.

### 6.3 Own-device exclusion (`/optout`)

`GET /optout?t=<ADMIN_TOKEN>` sets `lh_optout=1` (two-year `Max-Age`, `Path=/`,
`SameSite=Lax`, `Secure`, `HttpOnly`); `&off=1` clears it. Both `logVisit` and
`logClick` skip when the cookie is present. A wrong or missing token returns
the same 404 bounce a crawler gets, so the endpoint does not advertise itself.

**Cookie jars are per-browser, and the iOS escape deliberately moves the
visitor from the Instagram webview into Safari — two jars.** Opting out in
Safari does *not* opt out the webview hop, and on iOS the webview hop is the
one that logs (§3). A fully-excluded test device needs `/optout` run in both.

This only suppresses *future* rows. Historical self-traffic has to be deleted
by hand — see §9 for how the 2026-07-25 purge was done and backed up.

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
  - In-app-browser escape: IG-Android UA → 302 to `intent://` (no `package=`,
    fallback URL present); IG-iOS UA → interstitial whose body contains **zero**
    occurrences of the destination; real-Safari UA → plain 302, unchanged;
    either UA **with** `?b=1` → plain 302, so no loop; crawler → bounce with no
    `Location`, no `intent://`, no `x-safari-`. **Not yet verified on a real
    handset** — whether iOS honours the scheme without a user gesture can only
    be settled on a physical phone inside the Instagram app.
  - `robots.txt` serves and disallows AI crawlers.
  - `/api/analytics` → 401 without token, real JSON with token.
  - Visits and clicks actually persisted to D1 and surfaced in the summary
    (verified counts: 1 human + 2 bot visits, 1 click, from the test run).

- **Analytics metrics + `/optout` (2026-07-25), against `wrangler dev` and a
  shaped local D1 seed** (desktop-heavy, a deliberately zero-click tablet
  segment, a 21-visitor IG cohort):
  - `ctrByDevice` arithmetic correct per segment, including the zero-click
    tablet row rendering as `0% 0/9` rather than dropping out of the `LEFT
    JOIN`.
  - `/optout` gating: wrong token → 404 bounce with no `Set-Cookie`; correct
    token → cookie with the expected attributes; `&off=1` → `Max-Age=0`.
  - Suppression: a normal visit logs one `page_visits` + one `link_clicks`
    row; the same requests carrying `lh_optout=1` log **neither**; the cookie
    still matches mid-`Cookie`-string; a lookalike `xlh_optout=1` correctly
    does **not** match (regex boundary).
  - **Rendered in a real browser**, not just typechecked — which is what
    caught the wrapped-stat-tile layout bug (§4 `dashboard.ts`). No console
    errors.

**Self-traffic purge (2026-07-25).** Three test `visitor_hash` values
(`f80ea4f7…`, `95739d40…`, `346f59cd…`) held 98 `page_visits` and 18
`link_clicks` rows from the Jul 23–24 escape-testing sessions. Deleted from
production D1 after dumping all 116 rows to `analytics-purge-2026-07-25.bak`
as replayable `INSERT`s (gitignored via `*.bak`; restore with `wrangler d1
execute linkhub-db --remote --file=…`). Effect on the 30-day window:
`igSharePct` 10.8% → 2.2%, `igCtr` 23.8% → 31.6%, blended CTR 6.6% → 5.2%.
If you purge again, **look at the rows before deleting** — `visitor_hash`
collapses devices behind one IP (§6.2), so a hash is not guaranteed to be one
person's phone.

**2026-08-01 pass (§6.1) — what was verified, and how.**
- `via` classification, end to end against a running Worker: no Referer →
  `'direct'`; our own origin → `'page'`; `b=i` → `'escape'`; a foreign Referer
  → `'direct'`. Six requests, five rows.
- The dedupe: the sixth of those requests was the escape race (`b=i` then
  `e=to` from one visitor) and correctly collapsed to a single row.
- After deploy, one real `/go/vip` fetch with no Referer against production
  landed as `'direct'` and did **not** raise the tap count. Zero NULL `via`
  rows remain.
- The analytics payload was read back at both 7 and 30 days and asserted for
  rates above 100% — which is how the 160% desktop CTR was caught, since it
  typechecks perfectly and only fails arithmetically.
- **Rendered in a browser**, which caught the traffic chart flattening its two
  signal series onto zero. `tsc` cannot see that, and neither can a test that
  only reads the JSON.
- Cloaking invariants re-checked on the live site post-deploy: bot page has no
  `<script>`, no `.link-bar`, no `/go/` links; human page leaks no destination.

**Testing the tap feedback:** the animation is hard to observe by clicking,
since navigation starts immediately — freeze it from the console with
`document.querySelector('.link-card').classList.add('loading')`. See the README
for the LAN/phone recipe. The Instagram case cannot be tested without a deploy.

**Before ANY test tap on the live site, run `/optout` in both jars.** This is
the standing failure mode of this project, not a one-off: escape testing writes
visits and clicks into the live tables from the exact cohort — Instagram,
mobile — that the headline rate is computed over, so self-traffic inflates
precisely the number being read. It has already happened twice (the 2026-07-25
purge, and 2026-07-29's 9 visits / 8 taps which are still in the data because
they are indistinguishable after the fact). §6.3.

**Not yet tested (requires your account / a real domain):**
- The tap feedback inside a real Instagram webview on a physical handset —
  specifically that the press state and bar are visible during the escape's
  1500ms hold, which is the whole reason they exist.
- Behavior against a *real* `facebookexternalhit` hit with a real Meta ASN.
- Link-preview rendering in the Facebook Sharing Debugger.
- Cloudflare edge cache behavior under a custom domain.
- Real-world unique-visitor accuracy at volume.
- `/optout` inside the actual Instagram webview on a physical handset (the
  Safari jar is verified by construction; the webview jar is not).

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
   Domains & Routes).
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
3. Add an authenticated admin surface to create/edit pages and manage their
   domains (update the `domain` field, repoint DNS).
4. Dashboard already accepts a `page` param and partitions all queries by it;
   just add a page picker and scope the token per page/account.

---

## 13. Known limitations / honest caveats

- Classification can be fooled by a human-UA scraper; the URL-never-
  serialized + server-side-redirect properties are what still hold in that
  case, but a JS-rendering crawler with a human UA on a non-Meta ASN is the
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
- `visitor_hash` is a weak identity by design — IP + day, so it rotates nightly
  and collapses every device behind one IP (§6.2). Unique-visitor counts and
  any per-visitor attribution (including `igCtr`) inherit that fuzziness.
- `/optout` is per-browser and therefore easy to under-apply: miss the
  Instagram webview jar and iOS test traffic still logs (§6.3). There is no
  server-side way to confirm a device is fully excluded — check by testing and
  watching whether the row count moves.
- The desktop share of "human" traffic (~72% as of 2026-07-25) is not
  understood. It may be scrapers clearing `bot-detect.ts`, or it may be real.
  Until it is characterised, every all-traffic aggregate on the dashboard is
  measuring a population nobody has identified.

---

## 14. Product roadmap & handoff notes (for Claude Code / Codex / Cursor)

This section is written for a coding agent taking over the project. The owner
(single developer) intends to grow this from a single-model page into a
multi-tenant SaaS. Read §1–§13 first — especially §2 (request classification model) and §5
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
   `/go` or `/icon` references, no real profile photo, no text or imagery
   that identifies the destination. Bots get initials + gradient + glyphs only. (§5)
3. **Per-account isolation** — once multi-tenant, one account's data, links,
   and analytics must never be reachable by another account. Every query
   stays partitioned (today by `page_id`; add `account_id` above it).
4. **Secrets stay secrets** — `DASHBOARD_TOKEN`/`VISITOR_SALT` today, and any
   future per-user auth, are set via `wrangler secret` or a proper auth store,
   never committed to the repo or shipped to the client.

If a change would violate one of these to simplify the code, stop and find
another way. These are the product.

### 14.1 Build order (owner's stated priority)

**Phase 0 — Traffic acquisition + measurement hygiene (open, added
2026-07-25).** This jumped the queue because the 30-day numbers say the funnel
is not the constraint. After removing self-traffic, the window held **19 real
Instagram visits converting at 31.6%** out of 854 human visits — the page and
the escape work; almost nobody arrives through the bio link. Concretely:

1. **Owner action, blocking clean data:** run `/optout` on every test device,
   in both Safari *and* the Instagram webview (§6.3, §14.3). Until this is
   done, each escape-testing session re-poisons the tables the same way the
   Jul 23–24 sessions did.
2. **Characterise the desktop traffic** (~72% of "human" visits, converting at
   4.4%, mostly no-referrer Chrome). If it is scrapers clearing
   `bot-detect.ts`, tighten classification — it is currently diluting every
   all-traffic aggregate. Start from `browser` + `referrer` + hour-of-day
   distribution in `page_visits`; a scanner farm and an audience look nothing
   alike hour to hour.
3. **Then, and only then, optimise the page.** With ~19 IG visits per month,
   no card/copy/layout change produces a readable signal — the sample cannot
   distinguish a 30% tap rate from a 50% one. Volume first, conversion second.

Do not re-derive "the button might be broken" from a low `clickThroughRate`;
that reading has already been chased down once and the answer is §6.1.

**Phase 1 — Real analytics dashboard.** *Largely shipped* — time-series
charts, per-link/device/country/referrer/UTM drilldowns, bot-vs-human split,
and the §6.1 metrics are all live. The notes below are the original scope,
kept for the parts not yet done (chiefly: the dashboard is still a
self-contained HTML+JS string, and grows every time a panel is added).
Current `/dashboard` is a minimal token-gated view. Goals:
- Time-series charts (visits, unique visitors, clicks, CTR over time), not
  just totals. The `dailySeries` query already exists in `analytics.ts` — the
  data is there, the UI just doesn't chart it yet.
- Per-link click breakdown, device/country/referrer/UTM drilldowns (data
  already logged in `schema.sql`).
- Bot-vs-human split visible (crawler pressure is already logged — surface
  it, since it's genuinely useful for seeing how much automated traffic a
  domain attracts).
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
  and manage plans/billing state.
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
- Setting `wrangler secret` values. Note they are **write-only**: `wrangler
  secret list` returns names, never values, and neither the Cloudflare
  dashboard nor the API will read one back. A lost token is not recoverable,
  only replaceable — `wrangler secret put <NAME>` overwrites in place and takes
  effect in seconds with no redeploy. Keep `DASHBOARD_TOKEN` and `ADMIN_TOKEN`
  in a password manager, under names that distinguish them: they gate different
  surfaces (`/dashboard` + `/api/analytics` vs `/admin` + `/api/admin/*`) and
  are not interchangeable. `DASHBOARD_TOKEN` was rotated 2026-07-25 for exactly
  this reason.
- **Running `/optout` on your own test devices** (§6.3). An agent cannot do
  this — the cookie lives in the browser on your phone. Visit
  `https://example-links.com/optout?t=<ADMIN_TOKEN>` once in Safari and once
  inside the Instagram in-app browser, per device you test from.
- Stripe account, products, and webhook secrets (Phase 4).

### 14.4 Current live state (as of 2026-07-25)

- Deployed as Worker `linkhub` on the custom domain **`example-links.com`**
  (`wrangler.toml` `routes`). `workers.dev` is **disabled** — it is a shared
  domain, which defeats the point of running your own (§1; reasoning preserved
  in `wrangler.toml`).
- One page, one model (`Ana` / `@examplecreator`), one link → the destination, resolved
  server-side via `/go/vip`.
- Profile photo hosted in R2 and referenced via `avatarUrl`.
- D1 database `linkhub-db` live with the §6 schema; analytics logging
  confirmed working end-to-end.
- In-app-browser escape shipped and settled on both platforms: iOS via
  `instagram://extbrowser` (lands in Safari), Android via `intent://` (§3).
- Analytics metrics reworked (§6.1) and `/optout` added (§6.3). Self-traffic
  purged once, 2026-07-25 (§9).
- **Open, blocking clean measurement:** `/optout` has *not* yet been run on the
  owner's test devices (§14.1 Phase 0, §14.3). Until it is, escape testing
  keeps writing self-traffic into the same tables the dashboard reads.
- Honest read of the funnel at this date: ~19 real Instagram visits in 30 days
  converting at 31.6%, against 854 human visits total. Conversion is fine;
  arrivals are the constraint.

**Update 2026-08-01.** Click provenance, tap dedupe, cohort-matched CTR and
day-aligned windows shipped (§6.1). Production `link_clicks` migrated:
`migrations/0001-click-provenance.sql` applied to remote D1, 70 rows
classified 45 tap / 25 direct. What the 30-day window actually says now:

| | before | after |
|---|---|---|
| "Link clicks" | 70 | **45 taps** (+25 direct fetches, reported separately) |
| CTR headline | 5.6% blended | **39.4%** attributed (26/66) |
| IG tap rate | 25/51 | 25/51, unchanged — it was already cohort-matched |
| Desktop CTR | 3.8% of 838 visits | 10% of 10 attributed visits |

**Cross-checked against the destination platform's own counter, and it agrees.** The destination
is a tracking link (`destination.example/c1`), saved into the page config
2026-07-18 01:59 UTC — so the destination platform's counter starts there, not at first traffic.
Since that moment we issued 59 redirects, and the destination platform reports **26 clicks**. The
gap is not leakage, it is the two classes this pass just learned to exclude:

| our rows since `/c1` went live | n | reaches the destination? |
|---|---|---|
| direct fetches (`via='direct'`) | 18 | no — nothing follows the 302 |
| desktop taps | 14 | no — 13 of 14 from arrivals with no UTM and no IG referrer |
| **mobile taps** | **27** (24 in the IG cohort) | **yes** |
| less the two confirmed escape-race duplicates | **25** | |

25–27 on our side against 26 on theirs. **The tap → destination-landing step is
effectively lossless**, which is worth knowing: it means no future
disappointment should be blamed on the redirect, the cloaking, or the escape.
It also independently validates `via` and the dedupe window — two changes
derived from our data alone that landed on a number a third party had already
computed.

Still open, and now the largest remaining source of error: `/optout` has not
been run on the owner's test devices. 2026-07-29 alone shows 9 Instagram
visits and 8 taps, which reads as a test session rather than an audience, and
nothing in the code can tell the two apart. Until that is done, treat the
Instagram tap rate as an upper bound. Arrivals remain the constraint: 31
Instagram-webview visits in the last 7 days.
