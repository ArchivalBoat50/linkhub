# linkhub

A self-hosted, single-model link-in-bio page for Cloudflare Workers + D1.
Serves a clean, static page to Meta's crawlers and the real interactive link
page to actual visitors — with server-side analytics on both.

**Full technical detail, threat model, and reasoning: see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).** This README is the quick start.

## How it protects the real links (short version)

1. **Crawlers get a clean page.** `facebookexternalhit` and Meta's other
   crawlers don't run JavaScript and are detected by User-Agent + Meta's ASN
   (32934). They receive a legitimate-looking page with **no outbound
   destination links at all** — nothing to recursively follow.
2. **Real URLs are never in any page or API response.** The human page's
   links point at `/go/<id>` on the Worker itself. The real destination
   exists only inside the Worker, at click time, in a `302` `Location`
   header — never in HTML, JSON, view-source, or an archived snapshot.
3. **Every redirect is re-checked server-side.** `/go/<id>` re-runs
   classification; only a classified-human request gets the 302 to the real
   URL. A crawler hitting `/go/<id>` gets a bounce page with no real URL.
4. **Your own domain, no shared history.** Avoids the shared-domain
   reputation problem that flags Linktree/Beacons users. Rotate the domain if
   it's ever flagged; don't try to clean it.

This reduces detection risk. It does **not** eliminate platform ToS risk, and
it does nothing for account-level signals (your posts, hashtags, follow
graph) — see ARCHITECTURE.md §1–2 for the honest scope.

## What's tracked

Page visits and link clicks → D1: device, country (Cloudflare edge, no geo-IP
lookup), browser, referrer, UTM params, human-vs-bot, and which crawler hit
the safe page. Unique visitors use a salted **daily** hash of IP — never raw
IP. View it at `/dashboard` (token-gated).

**Judge the page on "IG tap rate" and the per-device CTR, not the headline
"CTR, all traffic".** The blended rate divides by every human visit including
desktop traffic that never came from the bio link, which drags it toward
meaninglessness — it read 6.6% while the Instagram audience was converting at
~32%. See ARCHITECTURE.md §6.1.

**Exclude your own devices before you trust any of it.** Testing the in-app
escape means loading the live page from a real phone, and those hits land in
the same tables — one session once logged 59 visits in 13 minutes. Visit
`/optout?t=<ADMIN_TOKEN>` on each test device, **once in the normal browser
and once inside the Instagram in-app browser** (separate cookie jars, and on
iOS the webview hop is the one that logs). `&off=1` reverses it. Details and
the reason a cookie is used instead of an IP blocklist: ARCHITECTURE.md §6.3.

## Setup

```bash
npm install --legacy-peer-deps
npx wrangler login

npx wrangler d1 create linkhub-db
# paste the returned database_id into wrangler.toml

npm run db:init:remote
npx wrangler secret put DASHBOARD_TOKEN   # long random string
npx wrangler secret put ADMIN_TOKEN       # a DIFFERENT long random string
npx wrangler secret put VISITOR_SALT      # a THIRD long random string
```

**Save those tokens in a password manager as you set them.** Cloudflare
secrets are write-only — `wrangler secret list` shows names only, and there is
no way to read a value back from the CLI, the API, or the dashboard. A lost
token can only be replaced (`wrangler secret put` overwrites in place, no
redeploy needed), not recovered. `DASHBOARD_TOKEN` gates `/dashboard` +
`/api/analytics`; `ADMIN_TOKEN` gates `/admin`, `/api/admin/*`, and `/optout`.
They are not interchangeable, so label them distinctly.

Edit `src/config.ts` (real name, bio, destination URLs) and `wrangler.toml`
(`PAGE_ID`, `MODEL_NAME`). Then:

```bash
npm run deploy
```

**Check your Cloudflare Bot Fight Mode / WAF.** It can block Meta's crawlers
before your Worker runs (HTTP 466 / 403), which breaks link previews. If Bot
Fight Mode is on, add a WAF skip rule for `ip.geoip.asnum eq 32934`. Verify
with the Facebook Sharing Debugger after deploy.

Then attach a custom domain (Workers & Pages → your worker → Settings →
Domains & Routes) — a fresh domain with no history on the flagged category.

## Local testing

```bash
npm run dev
# in another terminal:
curl -A "facebookexternalhit/1.1" http://127.0.0.1:8787/            # bot page: no /go links
curl -A "Mozilla/5.0 Chrome/120"  http://127.0.0.1:8787/            # human page: /go links
curl -sD - -A "Mozilla/5.0 Chrome/120" http://127.0.0.1:8787/go/vip # 302 to real URL
```

## Reusing for a second model

Clone, change `src/config.ts` + `PAGE_ID` + `MODEL_NAME`, deploy under a
different domain. Multiple Workers can share one D1 database (rows are
`page_id`-partitioned), which pre-populates the eventual multi-tenant view.
