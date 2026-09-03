# linkhub

## What this is, and the problem it solves

A link-in-bio page is a public URL fetched by everything: Meta's link-preview and
crawler agents (facebookexternalhit, meta-externalagent), generic scrapers,
link-checkers, and people. Hosted aggregators put every user on one shared domain
and serialise every destination URL into the page HTML, so any fetch reveals
where the links go, and the domain's reputation is shared with strangers. linkhub
is a self-hosted alternative that runs as a single Cloudflare Worker. It
classifies each request as human, Meta crawler, or generic bot using User-Agent
matching plus Cloudflare ASN verification (a Meta user-agent arriving from a
non-Meta ASN is treated as a bot, not a person). Crawlers get a complete static
page with no outbound destinations; people get an interactive page whose links
point back at the Worker; and destinations are resolved server-side per request,
so the real URL exists in exactly one place: the Location header of a 302 issued
to a request classified as human. Analytics live in D1 with salted daily IP
hashing behind a token-gated dashboard; uploaded media in R2.

Scope: this is link infrastructure. It controls what a fetch of the page reveals
and nothing else.

Request classification model, metric definitions and test record:
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Architecture

One Cloudflare Worker is the entire server. It classifies every request, decides
which of two page bodies to return, gates the redirect, records analytics, and
serves its own dashboard and admin editor. State lives in D1 (SQLite at the edge)
and optionally R2 (uploaded avatar/background media).

```
                    request
                       │
              force https (cf-visitor)
                       │
              classifyRequest()  ──  UA patterns + request.cf.asn
                       │
        ┌──────────────┴───────────────┐
        │                              │
   kind = human                  crawler / bot
        │                              │
   renderHumanPage()             renderBotPage()
   <a href="/go/id">             link LABELS only, no hrefs
   /icon/<id> logos              generic glyphs, initials avatar
   no destination string         no destination string
   cache: no-store               cache: private, max-age=300 + vary: UA
        │                              │
   log page_visit(is_bot=0)      log page_visit(is_bot=1, bot_type)
        │
        │  visitor taps a card
        ▼
   GET /go/<id>  ──  classifyRequest() runs AGAIN, fresh
        │
   ┌────┴─────────────────────────┐
   │                              │
 human                       crawler / bot
   │                              │
 log link_click(via)         renderBounce()
 302 → real URL              meta-refresh to /, no Location, no URL
 (only place it exists)
```

Modules (`src/`):

| File | Responsibility |
|---|---|
| `index.ts` | Worker entry: routing, HTTPS forcing, `/go` gate, `/icon`, `/robots.txt`, `/optout`, auth, R2 media |
| `bot-detect.ts` | Pure classification. No I/O. `human` / `meta_crawler` / `generic_bot` |
| `render.ts` | Three HTML renderers (human, bot, bounce) plus the two inline scripts |
| `page-store.ts` | D1-backed page config with a per-isolate cache and `validateConfig()` as the trust boundary |
| `analytics.ts` | Visitor hashing, D1 writes, and the aggregate query set behind the dashboard |
| `dashboard.ts` | Token-gated analytics UI (self-contained HTML+JS+inline SVG charts) |
| `admin.ts` | Token-gated in-place page editor |
| `config.ts` | Compile-time seed/fallback config; the D1 `pages` row wins once saved |

Routes: `/`, `/go/<id>`, `/icon/<id>`, `/media/<key>`, `/robots.txt`, `/optout`,
`/dashboard`, `/api/analytics`, `/admin`, `/api/admin/config`,
`/api/admin/upload`, `/favicon.ico` (204), everything else 404.

Data model: `pages` (runtime config), `page_visits`, `link_clicks`. Every row
carries `page_id` as a partition key from the first migration, so going
multi-tenant is a routing change rather than a data migration.

## Key design decisions

**Real destination URLs are never serialized into any client-readable
response.** Not in HTML, not in JSON, not in an OG tag, not in an image `src`.
*Reason:* classification is the first line of defence, but User-Agent strings are
trivially spoofable and some scrapers do execute JavaScript, so a scraper sending
a plain Chrome UA from a residential IP is indistinguishable from a human at the
classification layer. The design assumes classification will eventually be
fooled, and puts a structural property behind it: even a scraper that passes as
human has to load the page, follow each `/go/<id>` individually, and clear
classification again on that request — and the destination still only appears in
a `Location` header on a live 302, never in cacheable or archivable body content.
There is no single fetch that dumps the link list. An earlier `/api/resolve`
endpoint that returned all URLs as JSON to any browser-like UA was removed for
exactly this reason.

**Every redirect is re-classified server-side at click time.** `/go/<id>` does
not trust that whoever is asking already passed the check on `/`. *Reason:* the
two requests are independent; a crawler can hit `/go/vip` directly without ever
fetching `/`. A crawler that does gets `renderBounce()` — a meta-refresh back to
`/` with no `Location` header and no destination anywhere in the body.

**Meta's ASN 32934 is checked alongside — and now ahead of — User-Agent.**
*Reason:* a UA header is attacker-controlled; `request.cf.asn` comes from
Cloudflare's own edge data and is not. Two distinct uses. First, a Meta-looking
UA arriving from a non-Meta network is still treated as a crawler (fail safe) but
tagged `-unverified-asn`, so spoof attempts are visible in the analytics rather
than silently indistinguishable. Second — added later, in commit `e055b47` — any
request from ASN 32934 is classified as a crawler *before* the human/webview
checks, even when it carries an ordinary browser UA, so a human reviewer browsing
from inside Meta's network gets the clean bounce instead of the real redirect.
The stated justification is that no real Instagram visitor is ever on Meta's ASN
(fan traffic arrives from mobile carriers and residential ISPs), so this closes
that gap at zero false-positive cost. Plain browsers on Meta's network are tagged
`meta-asn-browser`, which separates "Instagram scanned my link" from "someone at
Meta opened it" on the dashboard. `[CONFIRM]` — the zero-false-positives claim is
asserted from reasoning about how carrier traffic is routed, not from a measured
check against the logs. Worth confirming before defending it as a fact.

**In-app webview UAs are classified as human, ahead of every bot pattern.**
*Reason:* an Instagram, Messenger, TikTok or WeChat webview is a real person, and
those UA strings contain tokens that a generic `bot|spider|crawler` substring
match could plausibly catch. Getting this wrong would serve the linkless crawler
page to the entire actual audience, which is a silent, total failure. It is the
first check for that reason.

**Per-card logos are proxied through `/icon/<id>` rather than referenced
directly.** *Reason:* the obvious implementation —
`google.com/s2/favicons?domain=destination.example` in an `<img src>` — writes the
destination domain into the page HTML as a string, which a crawler reads
perfectly well. That defeats the entire cloaking scheme through a decorative
feature. Instead the card references `/icon/<id>` on the Worker, which
re-classifies the request and, only for a human, fetches the favicon
server-to-server and streams the bytes back. A crawler gets a 1×1 transparent
PNG. The bot page emits no `/icon/` references at all. Every image tag carries
`referrerpolicy="no-referrer"` so nothing leaks through a `Referer` on an image
load either.

**Cloudflare Workers + D1 rather than a conventional server.** `[CONFIRM]` — no
document or commit states this rationale; the following is inference from what
the code actually depends on. The design leans on three Cloudflare-specific
things that a normal server would have to buy or build: `request.cf.asn` for the
Meta network check (no third-party ASN lookup, and not a spoofable header),
`request.cf.country` for geography (no geo-IP vendor, no PII beyond a hashed IP),
and edge execution, which matters because the page's entire job is one fast tap
on cellular and the perf commit treats load time as the conversion metric.
Beyond that: no servers to patch, and
domain rotation is a `wrangler.toml` change plus DNS rather than an
infrastructure move. The costs are real and should be acknowledged in the same
breath — D1 is SQLite with per-query latency on the hot path, there is no
long-running process, and the analytics writes have to ride `ctx.waitUntil()`.

**HTTPS is forced inside the Worker, keyed on the `cf-visitor` header.**
*Reason:* Instagram stores bio links without a scheme and opens them over
`http://`, and the zone had no HTTPS redirect, so genuine traffic was arriving in
cleartext. This was a real hole, not hygiene: the 302 carrying the real
destination was travelling unencrypted, which hands the account → destination
association to anyone on the network path — precisely the link the design exists
to conceal. It also made `og:url` advertise `http://` to Meta's crawler. It was
found in the logs (`Referer` on every recorded mobile tap read `http://…`), not
by inspection. `cf-visitor` is the signal rather than `url.protocol` or the
`Host` header specifically because `wrangler dev` rewrites both of those to the
production custom domain over http, so a host-based check redirects every local
request to production.

**The iOS in-app escape uses `instagram://extbrowser`, not a browser scheme.**
*Reason:* nearly all traffic arrives inside Instagram's WebView, and a webview
session starts logged out every time — no saved login on the destination, no
password autofill, no Apple/Google Pay — so a tap that stays inside the webview
costs conversion. `instagram://extbrowser/?url=<https url>` is Instagram's own
private deeplink, answered by the Instagram app that is *hosting* the webview,
meaning "open this in the device's default browser". Because it targets the
host app's scheme rather than a browser's, iOS does not gesture-gate it: it fires
on page load with no tap and needs no particular browser installed. That is why
it works where `x-safari-https://`, `com-apple-mobilesafari-tab://` and
`googlechrome://` did not — all three were probed on real hardware first. Android
escapes server-side instead, via a 302 to an `intent://` URI with deliberately no
`package=`, so the system resolves it with the user's default browser rather than
forcing Chrome. Cloaking survives both paths because the escape URL points at
our own `/go/<id>`, never at the destination.

**A "click" is a tap, not a request.** `link_clicks.via` is
`'page' | 'escape' | 'direct'`. *Reason:* a genuine card tap is a same-origin
navigation and always sends a `Referer` naming our own host, because the page
sets no referrer policy. A bare fetch of `/go/<id>` by something that harvested
the path out of the HTML sends none. Counting both as clicks made 25 of the first
70 production rows not clicks — 36% of the reported number. The one honest
exception is the iOS escape hop, which Safari opens as a fresh navigation with no
`Referer` and therefore looks exactly like a scraper; the `b=i` marker is the only
thing that separates them, so it is checked first. That ambiguity was resolved
empirically before the rule was written: zero of the 25 Referer-less rows belonged
to a visitor who had an Instagram webview visit that day, so none could have been
escape hops. Only `'page'` and `'escape'` reach the headline count; `'direct'` is
reported separately so removing it reads as a correction rather than a
disappearance.

**One tap must produce exactly one row, and the two platforms escape at
different points.** Android escapes server-side, so the webview request reaches
the Worker and is logged there; the default browser's re-entry carries `b=a` and
must *not* log again. iOS escapes on the page before any request is made, so the
`b=i` hop from Safari is the *only* record of the tap and must log. An earlier
revision suppressed logging on every escape hop — correct for Android, wrong for
iOS — which would have dropped every successfully escaped click from analytics.
Shipped that way, the feature working would have looked identical to traffic
collapsing. A server-side dedupe backstops the residual race: the iOS card-tap
escape arms a 1500 ms fallback timer, and a successful escape that does not hide
the webview in time writes both hops. `logClick()` drops a repeat of the same
`(page_id, link_id, visitor_hash)` inside 10 seconds — 10 and not 60 because
`visitor_hash` folds in the IP and carrier CGNAT puts many real people behind one
mobile IP, so a wide window would silently eat unrelated visitors' taps.

**Unique visitors use a salted hash of IP that rotates daily, not a raw IP or a
permanent hash.** `hashVisitor()` is `SHA-256(ip | YYYY-MM-DD | salt)`. *Reason:*
a raw IP is PII with no upside here; a permanent salted hash is a stable
pseudonymous identifier that would let the dataset track a person across weeks,
which the product has no need for. Folding the calendar day in means
unique-visitor counts work per day and are not linkable across days — the
intended privacy posture, and a deliberate cap on what the analytics can ever be
used for. The costs are documented rather than hidden: the key rotates at
midnight UTC, so a visitor who lands before midnight and taps after is missed by
any cohort match, and every device behind one IP collapses to one hash. Both are
smaller distortions than the ones they remove.

**Own-device exclusion is a cookie, not a visitor-hash blocklist.** *Reason:* the
blocklist is the obvious design and it cannot work — the hash rotates every
midnight and again whenever a phone changes IP, so the key is gone within a day.
A cookie is the one marker that survives both. `/optout?t=<ADMIN_TOKEN>` sets it;
a wrong token returns the same 404 bounce a crawler gets, so the endpoint does
not advertise itself. The known weakness is stated up front: cookie jars are
per-browser, and the iOS escape deliberately moves the visitor from the Instagram
webview into Safari, so a fully excluded test device needs `/optout` run in both
jars.

**Rates are computed over one population, with both sides cohort-matched.**
`attributedVisits` are human visits carrying a UTM or a recognised platform
referrer; `attributedClicks` are taps by visitors *in that same cohort*, matched
by `visitor_hash`. *Reason:* the blended `clicks ÷ all human visits` rate read
6.6% while the audience it existed to measure was converting near 32%, entirely
because of denominator composition — 1002 of 1253 "human" visits had no referrer
and no UTM, and 838 were desktop against 414 mobile on a link that is
mobile-only. The cohort join is not optional: the first cut divided all taps by
attributed visits without it and produced a desktop CTR of **160%**, because
desktop taps came overwhelmingly from visitors whose arrival was never
attributed. A rate whose two sides describe different populations is not a rate.
Unattributed traffic, direct fetches and crawler hits are shown in a separate
"traffic quality" panel that states why each is excluded, never in a denominator.

**Time windows are day-aligned to UTC midnight.** `windowStart()` returns
midnight of `(today − days + 1)`. *Reason:* the previous rolling `now − 7×86400`
cutoff landed mid-day, so the oldest bucket in every chart was a partial day
drawn as a full one, and asking the same question twice in one afternoon returned
two different totals.

**The bot page and the human page have different cache semantics.** Human `/` is
`no-store`; bot `/` is `private, max-age=300` with `vary: User-Agent`; `/go` and
the bounce are `no-store`. *Reason:* both bodies are served from the same URL, so
a shared cache that stored one and served it to the other would invert the entire
scheme — a human could receive the linkless page, or a crawler could receive the
human one. `private` keeps the bot page out of shared caches while still letting
Meta's repeat previews be cheap. `[CONFIRM]` — the 300-second figure is not
justified anywhere; be ready to say why five minutes rather than any other number,
or say it was a judgment call.

**Page config lives in a D1 row, edited through a token-gated admin surface, with
server-side validation as the trust boundary.** *Reason:* moving the profile out
of compile-time `config.ts` means edits do not require a redeploy, and it is the
same primitive multi-tenant will reuse (the `pages` table already carries a
stubbed `account_id`). `validateConfig()` strips unknown keys, enforces an
http(s)-only URL allowlist and unique link ids. One field is a hard injection
boundary: `backgroundPosition` is interpolated straight into a `style` attribute,
so it is normalized against `^<num>% <num>%$` and anything unrecognised collapses
to the centred default rather than failing the save. A malformed stored row falls
back to the compile-time config rather than taking the page down. Config is cached
per isolate for 60 s, so a warm request does zero I/O on the latency-sensitive
page path. `[CONFIRM]` — the 60 s TTL bounds how long a stale page is served after
an edit; the tradeoff is stated in the code but the specific number is not
justified.

## Measured results

These are the numbers that appear in the code, docs and commit history. They come
from a single low-volume deployment, over 7- and 30-day windows in July and
August 2026, and the docs are explicit that the data still contains
self-traffic. Read them as evidence that specific bugs were found and fixed, not
as performance claims.

**Click-counting correction (2026-08-01, 30-day window).** Auditing 70 production
`link_clicks` rows found three independent errors:

| | before | after |
|---|---|---|
| "Link clicks" | 70 | 45 taps, + 25 direct fetches reported separately |
| Headline CTR | 5.6% blended | 39.4% attributed (26/66) |
| Instagram tap rate | 25/51 | 25/51 — unchanged, already cohort-matched |
| Desktop CTR | 3.8% of 838 visits | 10% of 10 attributed visits |

36% of the previous "click" count were bare fetches. Two double-logged iOS taps
were found in production, 1.7 s and 3.7 s apart. A first cut of the attributed
rate reported a desktop CTR of 160%, caught by asserting on the API payload for
rates above 100%.

**Independent cross-check against the destination platform's own counter.** Since
the tracking link went live, the Worker issued 59 redirects. Excluding 18 direct
fetches and 14 desktop taps leaves 27 mobile taps, or 25 after removing the two
confirmed duplicates; the destination platform reported 26 clicks over the same
period. 25–27 against 26 — the tap → destination step is effectively lossless,
and two corrections derived only from this project's own data landed on a number
a third party had already computed independently.

**Self-traffic purge (2026-07-25).** Three test `visitor_hash` values held 98
`page_visits` and 18 `link_clicks` rows from escape-testing sessions; one session
alone logged 59 visits in 13 minutes. Removing them moved the 30-day Instagram
share from 10.8% to 2.2% and the Instagram CTR from 23.8% to 31.6%.

**Page weight (commit `ecf0322`).** 543 KB → 146 KB, a 73% cut, and from three
origins to one. The avatar went from a 1920×2560 / 412 KB photo filling a 96 px
circle to a 288×288 q80 crop at ~20 KB — 95% smaller with no visible change —
served same-origin from R2 instead of a cross-origin bucket host. Fonts moved
from a render-blocking Google Fonts stylesheet to self-hosted `@font-face` in the
inline stylesheet, removing two DNS + TLS round trips before first paint.

**Funnel state at 2026-07-25.** ~19 real Instagram visits in 30 days converting
at 31.6%, against 854 human visits total. The documented reading: conversion is
fine, arrivals are the constraint, and at that sample size no page tweak produces
a readable signal.

**Testing.** `tsc --noEmit` clean; 12 hand-written classification cases across
realistic UA/ASN combinations; end-to-end runs against `wrangler dev` with a
local D1 and a shaped seed, covering the human/bot split, the `/go` gate, all
four escape hops, `/optout` cookie states, and the zero-click `LEFT JOIN` path.
No automated test suite is committed — the tests were run ad hoc during audits.

## Stack

TypeScript (strict) on Cloudflare Workers, Cloudflare D1 for storage, Cloudflare
R2 for uploaded media, Wrangler for local dev and deploy. No framework, no
bundler config, no runtime dependencies — `package.json` has three devDependencies
and nothing else. The dashboard and admin UIs are self-contained HTML + inline JS
strings with hand-written inline-SVG charts.

## Running locally

```bash
npm install --legacy-peer-deps    # peer-dep skew between wrangler and the type package
npx wrangler login

npx wrangler d1 create linkhub-db
# paste the returned database_id into wrangler.toml

npm run db:init                   # local D1
npm run dev                       # http://127.0.0.1:8787
```

Secrets are set with `npx wrangler secret put <NAME>`: `DASHBOARD_TOKEN` gates
`/dashboard` and `/api/analytics`; `ADMIN_TOKEN` gates `/admin`, `/api/admin/*`
and `/optout`; `VISITOR_SALT` is the IP-hashing salt. They are write-only —
`wrangler secret list` returns names, never values — so a lost token can only be
replaced, not recovered.

Exercising both paths is a curl away, which is the fastest way to confirm a
refactor did not break the cloaking:

```bash
curl -A "facebookexternalhit/1.1" http://127.0.0.1:8787/            # bot page: zero /go links
curl -A "Mozilla/5.0 Chrome/120"  http://127.0.0.1:8787/            # human page: /go links
curl -sD - -A "Mozilla/5.0 Chrome/120" http://127.0.0.1:8787/go/vip # 302 to the real URL
```

Note that `request.cf.asn` is absent under `wrangler dev`, so `index.ts` sets
`trustMetaUAWithoutASN` for localhost; ASN behaviour has to be tested against a
real deploy or `wrangler dev --remote`. `/go/<id>` redirects to the real
destination in dev too, so point the local config at a dummy URL before tapping
it repeatedly. Deploying needs a custom domain with no prior history, and a WAF
skip rule for `ip.geoip.asnum eq 32934` if Bot Fight Mode is on — otherwise
Cloudflare blocks Meta's crawler before the Worker ever runs and link previews
break.

## Known limitations, and what I would do next

**The ceiling of the approach is stated in the design, not discovered later.** If
Meta ever moves *integrity* crawling — not just link previews — to a
JS-rendering crawler with a human UA on Meta's ASN, the network gate would catch
it, but a JS-rendering crawler on a non-Meta network with a human UA would be
classified human and receive real 302s. The
URL-never-serialized property still holds, but destinations become discoverable
by following each `/go/<id>` individually. The next layer would be per-link
friction: an interstitial requiring a genuine user gesture, or short-lived signed
`/go` tokens minted only by the human page. Not built.

**No rate limiting on `/go/*`.** Link ids are not secret and a scraper can
enumerate them. A per-IP-hash limit is the cheap version of the signed-token work
above.

**~72% of "human" traffic is not understood.** Mostly no-referrer desktop Chrome,
skewed to SG/NL/CN/HK, converting at a fraction of mobile. It may be scrapers
clearing `bot-detect.ts` or it may be real. Until it is characterised, every
all-traffic aggregate describes a population nobody has identified. The next
concrete step is an hour-of-day and browser/referrer distribution comparison — a
scanner farm and an audience look nothing alike hour to hour.

**Self-traffic still contaminates the tables.** `/optout` has not been run on the
owner's test devices; 2026-07-29 alone shows 9 Instagram visits and 8 taps, which
reads as a test session rather than an audience, and nothing in the code can tell
the two apart after the fact. The Instagram tap rate should be treated as an
upper bound until that is done. This is a process gap the code cannot close.

**No automated test suite.** Everything was verified ad hoc. `vitest` +
`@cloudflare/vitest-pool-workers` is the obvious addition, and the highest-value
targets are the classification table and the `via` / dedupe logic, both of which
are pure enough to test cheaply. Two of the three worst bugs found so far —
the 160% CTR and a chart that flattened its signal series onto zero — typecheck
perfectly and only fail arithmetically or visually, so the tests would need to
assert on payload values and the dashboard would still need a browser.

**The Android `intent://` escape has never been verified on real hardware.** It
is reasoned through and tested against a spoofed UA locally, nothing more.

**`timingSafeEqual` returns early on a length mismatch**, so it leaks token
length. The code comment acknowledges it is "not cryptographically perfect in JS".
`[CONFIRM]` — worth deciding whether to defend this as an acceptable tradeoff for
a long random token, or to fix it by hashing both sides to a fixed length first.

**The `/icon/<id>` proxy resolves favicons through Google's favicon service.** The
destination host never reaches the client, but it does reach Google in a
server-to-server request. `[CONFIRM]` — no document weighs that tradeoff; decide
whether it is acceptable or whether the Worker should fetch and parse the
destination itself.

**`ARCHITECTURE.md` §4 describes the old classification order** (webviews first,
then Meta UA + ASN). The shipped code checks the Meta ASN gate *before* the
webview checks, per commit `e055b47`. The commit explains the change; the
architecture document was not updated to match. `[CONFIRM]` — worth reconciling
before anyone reads both.

**Multi-tenant is a routing change, not a migration**, and that was the point of
partitioning by `page_id` from the first schema. The remaining work is an
`accounts` table, per-account auth to replace the single `DASHBOARD_TOKEN`, and
resolving config by hostname instead of a compile-time `PAGE_ID`. The config
lookup is already a D1 read behind a per-isolate cache, so that path is in place.
