export interface Env {
  DB: D1Database;
  PAGE_ID: string;
  MODEL_NAME: string;
  DASHBOARD_TOKEN: string;
  VISITOR_SALT: string;
  // Admin surface (see src/admin.ts). Token gate for /api/admin/*.
  ADMIN_TOKEN: string;
  // Optional R2 bucket for admin image uploads. When unbound, the upload
  // endpoint 501s and admins can still paste hosted image URLs.
  MEDIA?: R2Bucket;
}

// Never store raw IPs. Hash IP + calendar day + a secret salt so you can
// still count unique visitors/day without keeping anything that identifies
// a real person or device long-term.
export async function hashVisitor(ip: string, salt: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const enc = new TextEncoder().encode(`${ip}|${day}|${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseUTM(url: URL) {
  return {
    utm_source: url.searchParams.get("utm_source"),
    utm_medium: url.searchParams.get("utm_medium"),
    utm_campaign: url.searchParams.get("utm_campaign"),
  };
}

interface VisitRow {
  pageId: string;
  isBot: boolean;
  botType: string | null;
  isIgWebview: boolean;
  country: string | null;
  device: string;
  browser: string;
  referrer: string | null;
  utm: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null };
  visitorHash: string;
}

export async function logVisit(env: Env, row: VisitRow) {
  await env.DB.prepare(
    `INSERT INTO page_visits
      (page_id, ts, is_bot, bot_type, is_ig_webview, country, device, browser, referrer, utm_source, utm_medium, utm_campaign, visitor_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.pageId,
      Date.now(),
      row.isBot ? 1 : 0,
      row.botType,
      row.isIgWebview ? 1 : 0,
      row.country,
      row.device,
      row.browser,
      row.referrer,
      row.utm.utm_source,
      row.utm.utm_medium,
      row.utm.utm_campaign,
      row.visitorHash
    )
    .run();
}

// How a /go/<id> request came to exist. This is the difference between a tap
// and a fetch, and without it the click count is not a click count:
//
//   'page'   the Referer is our own origin — someone tapped a card on the page.
//   'escape' the iOS `b=i` hop. The Instagram webview handed the URL to Safari,
//            which opens it as a FRESH navigation carrying no Referer at all.
//            Genuine, and indistinguishable from 'direct' on the Referer alone
//            — which is exactly why the escape mark has to be recorded.
//   'direct'  neither. Nobody had our page in front of them; something fetched
//            /go/<id> straight off the wire. Scrapers harvest the path out of
//            the HTML and follow it.
//
// Verified against production before this column existed: of 70 rows, 25 had no
// Referer, and ZERO of those 25 belonged to a visitor who had an Instagram
// webview visit that day. So none were escape hops — all 25 were fetches, 36%
// of the "clicks" the dashboard was reporting.
export type ClickVia = "page" | "escape" | "direct";

interface ClickRow {
  pageId: string;
  linkId: string;
  country: string | null;
  device: string;
  referrer: string | null;
  utm: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null };
  visitorHash: string;
  via: ClickVia;
}

// The same visitor tapping the same link twice inside this window is one tap.
//
// Sized to the iOS card-tap escape race, which is the mechanical source of the
// duplicates: render.ts fires `instagram://extbrowser` and arms a 1500ms
// fallback timer, so a successful escape that doesn't hide the webview in time
// lands BOTH the Safari `b=i` hop and the webview `e=to` hop. Neither is
// suppressible server-side on its own — each is the only record of the tap in
// the case it was written for. Confirmed in production: two pairs 1.7s and 3.7s
// apart, both from Instagram mobile visitors.
//
// 10s, not 60s, on purpose. `visitor_hash` folds in the IP, and carrier CGNAT
// puts many real people behind one mobile IP — a wide window would silently eat
// unrelated visitors' taps. 10s covers the 1.5s timer plus a slow handoff with
// room to spare, and every duplicate actually observed fell inside 4s.
const CLICK_DEDUPE_MS = 10_000;

export async function logClick(env: Env, row: ClickRow) {
  const now = Date.now();

  const dupe = await env.DB.prepare(
    `SELECT 1 FROM link_clicks
      WHERE page_id = ? AND link_id = ? AND visitor_hash = ? AND ts > ?
      LIMIT 1`
  )
    .bind(row.pageId, row.linkId, row.visitorHash, now - CLICK_DEDUPE_MS)
    .first<{ 1: number }>();
  if (dupe) return;

  await env.DB.prepare(
    `INSERT INTO link_clicks
      (page_id, link_id, ts, country, device, referrer, utm_source, utm_medium, utm_campaign, visitor_hash, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.pageId,
      row.linkId,
      now,
      row.country,
      row.device,
      row.referrer,
      row.utm.utm_source,
      row.utm.utm_medium,
      row.utm.utm_campaign,
      row.visitorHash,
      row.via
    )
    .run();
}

// A tap is any click that isn't a bare fetch of /go/<id>. NULL means the row
// predates the `via` column (see migrations/0001) — treated as a tap so a
// skipped migration degrades to the old numbers rather than silently reading 0.
const IS_TAP = `COALESCE(via, 'page') <> 'direct'`;

// Visits we can actually attribute to a channel: either the bio link's own UTMs
// survived, or the Referer names a platform we recognise. Everything else is
// "unattributed" — no referrer, no UTM, which is what a scanner looks like and
// what 1002 of 1253 production "human" visits were when this was written.
const ATTRIBUTED = `(utm_source IS NOT NULL OR referrer LIKE '%instagram.com%'
  OR referrer LIKE '%t.co%' OR referrer LIKE '%twitter.com%' OR referrer LIKE '%//x.com%'
  OR referrer LIKE '%tiktok.com%' OR referrer LIKE '%facebook.com%' OR referrer LIKE '%fb.com%'
  OR referrer LIKE '%youtube.com%' OR referrer LIKE '%youtu.be%' OR referrer LIKE '%reddit.com%'
  OR referrer LIKE '%google.%')`;

// The visitors behind the attributed visits, for matching clicks back to the
// same population. A rate whose numerator and denominator describe different
// people is not a rate — the first cut of this file put taps over attributed
// visits without this join and produced a desktop CTR of 160%, because desktop
// taps came overwhelmingly from visitors whose arrival was never attributed.
//
// Same visitor_hash mechanism the Instagram cohort uses, and the same caveat:
// the hash folds in the calendar day, so a visitor who lands before midnight
// and taps after is missed, and CGNAT collapses several people behind one
// mobile IP. Both are smaller distortions than the one being removed.
const ATTRIBUTED_COHORT = `visitor_hash IN (
  SELECT visitor_hash FROM page_visits
   WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND ${ATTRIBUTED})`;

// Day-aligned window start (UTC). "Last 7 days" means seven whole calendar
// days ending today, NOT a rolling 168 hours: a rolling cutoff lands mid-day,
// so the oldest bucket in the chart was a partial day drawn as a full one, and
// the same question asked twice in one afternoon gave two different totals.
export function windowStart(sinceDays: number): number {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime() - (sinceDays - 1) * 24 * 60 * 60 * 1000;
}

export async function getAnalyticsSummary(env: Env, pageId: string, sinceDays = 30) {
  const since = windowStart(sinceDays);

  const [
    visits,
    humanVisits,
    botVisits,
    uniqueHumans,
    clicksByLink,
    deviceSplit,
    countrySplit,
    botTypeSplit,
    referrerSplit,
    visitsByDay,
    clicksByDay,
    utmSourceSplit,
    utmMediumSplit,
    utmCampaignSplit,
    trafficSources,
    hourly,
    igWebviewVisits,
    ctrByDevice,
    igCohort,
    directHits,
    attributedVisits,
    attributedClicks,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ?`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT visitor_hash) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT link_id, COUNT(*) n FROM link_clicks WHERE page_id = ? AND ts >= ? AND ${IS_TAP} GROUP BY link_id ORDER BY n DESC`).bind(pageId, since).all<{ link_id: string; n: number }>(),
    env.DB.prepare(`SELECT device, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY device ORDER BY n DESC`).bind(pageId, since).all<{ device: string; n: number }>(),
    env.DB.prepare(`SELECT country, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY country ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ country: string; n: number }>(),
    env.DB.prepare(`SELECT bot_type, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1 GROUP BY bot_type ORDER BY n DESC`).bind(pageId, since).all<{ bot_type: string; n: number }>(),
    env.DB.prepare(`SELECT referrer, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY referrer ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ referrer: string; n: number }>(),
    // Per-day visit rollup: human, unique-human, and bot counts in one pass.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch')) day,
              SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) humans,
              SUM(CASE WHEN is_bot = 0 AND ${ATTRIBUTED} THEN 1 ELSE 0 END) attributed,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN visitor_hash END) uniques,
              SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) bots
       FROM page_visits WHERE page_id = ? AND ts >= ?
       GROUP BY day ORDER BY day ASC`
    ).bind(pageId, since).all<{ day: string; humans: number; attributed: number; uniques: number; bots: number }>(),
    // Per-day click rollup, joined to the visit series by day below.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch')) day, COUNT(*) clicks,
              SUM(CASE WHEN ${ATTRIBUTED_COHORT} THEN 1 ELSE 0 END) attributedClicks
       FROM link_clicks WHERE page_id = ? AND ts >= ? AND ${IS_TAP}
       GROUP BY day ORDER BY day ASC`
      // Cohort subquery binds first — it appears earlier in the statement text.
    ).bind(pageId, since, pageId, since).all<{ day: string; clicks: number; attributedClicks: number }>(),
    env.DB.prepare(`SELECT utm_source, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND utm_source IS NOT NULL GROUP BY utm_source ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ utm_source: string; n: number }>(),
    env.DB.prepare(`SELECT utm_medium, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND utm_medium IS NOT NULL GROUP BY utm_medium ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ utm_medium: string; n: number }>(),
    env.DB.prepare(`SELECT utm_campaign, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND utm_campaign IS NOT NULL GROUP BY utm_campaign ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ utm_campaign: string; n: number }>(),
    // Unified traffic source: utm_source wins; otherwise derive a platform from
    // the referrer host; otherwise "direct". This is the "where did they come
    // from" view — no third-party pixel, just UTMs + referrer we already log.
    env.DB.prepare(
      `SELECT COALESCE(utm_source, CASE
          WHEN referrer IS NULL OR referrer = '' THEN 'direct'
          WHEN referrer LIKE '%instagram.com%' THEN 'instagram'
          WHEN referrer LIKE '%t.co%' OR referrer LIKE '%twitter.com%' OR referrer LIKE '%//x.com%' THEN 'twitter/x'
          WHEN referrer LIKE '%tiktok.com%' THEN 'tiktok'
          WHEN referrer LIKE '%facebook.com%' OR referrer LIKE '%fb.com%' THEN 'facebook'
          WHEN referrer LIKE '%youtube.com%' OR referrer LIKE '%youtu.be%' THEN 'youtube'
          WHEN referrer LIKE '%reddit.com%' THEN 'reddit'
          WHEN referrer LIKE '%google.%' THEN 'google'
          ELSE 'other'
        END) source, COUNT(*) n
       FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0
       GROUP BY source ORDER BY n DESC LIMIT 12`
    ).bind(pageId, since).all<{ source: string; n: number }>(),
    // Hour-of-day histogram (UTC) for human visits — when your audience shows up.
    env.DB.prepare(
      `SELECT CAST(strftime('%H', datetime(ts/1000, 'unixepoch')) AS INTEGER) hour, COUNT(*) n
       FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0
       GROUP BY hour ORDER BY hour ASC`
    ).bind(pageId, since).all<{ hour: number; n: number }>(),
    // Share of human visits that came from inside the Instagram in-app browser.
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND is_ig_webview = 1`).bind(pageId, since).first<{ n: number }>(),
    // CTR per device. The flat site-wide rate mixes two populations that behave
    // nothing alike — over the 30 days to 2026-07-24, desktop converted at 4.4%
    // and mobile at 10.7%, and desktop was two thirds of the denominator, so the
    // blended 6.6% described neither. Split it and each number means something.
    //
    // Both sides are now the attributed population: taps over attributed visits.
    // Splitting by device was never enough on its own, because the desktop row's
    // denominator was mostly scanners — 838 desktop "human" visits against 414
    // mobile, when the bio link this page exists to serve is mobile-only.
    env.DB.prepare(
      `SELECT d.device, d.visits, COALESCE(c.clicks, 0) clicks
       FROM (SELECT device, COUNT(*) visits FROM page_visits
             WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND ${ATTRIBUTED} GROUP BY device) d
       LEFT JOIN (SELECT device, COUNT(*) clicks FROM link_clicks
                  WHERE page_id = ? AND ts >= ? AND ${IS_TAP} AND ${ATTRIBUTED_COHORT}
                  GROUP BY device) c ON c.device = d.device
       ORDER BY d.visits DESC`
    ).bind(pageId, since, pageId, since, pageId, since).all<{ device: string; visits: number; clicks: number }>(),
    // The number that actually answers "do people who arrive from the bio link
    // tap the card". Clicks are attributed by visitor_hash, which is stable
    // within a UTC day (hashVisitor folds the date in) — so this counts a tap
    // from someone whose visit that day came through the Instagram webview. A
    // visitor who lands before midnight and taps after is missed; at this
    // traffic volume that's rarer than the distortion it removes.
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM page_visits
               WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND is_ig_webview = 1) visits,
              (SELECT COUNT(*) FROM link_clicks WHERE page_id = ? AND ts >= ? AND ${IS_TAP}
               AND visitor_hash IN
                (SELECT visitor_hash FROM page_visits
                 WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND is_ig_webview = 1)) clicks`
    ).bind(pageId, since, pageId, since, pageId, since).first<{ visits: number; clicks: number }>(),
    // Fetches of /go/<id> by something that never had the page open. Reported,
    // never counted as taps — this was 36% of the old "clicks" number.
    env.DB.prepare(`SELECT COUNT(*) n FROM link_clicks WHERE page_id = ? AND ts >= ? AND via = 'direct'`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 AND ${ATTRIBUTED}`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) n FROM link_clicks
        WHERE page_id = ? AND ts >= ? AND ${IS_TAP} AND ${ATTRIBUTED_COHORT}`
    ).bind(pageId, since, pageId, since).first<{ n: number }>(),
  ]);

  const totalClicks = clicksByLink.results.reduce((a, r) => a + r.n, 0);
  const humanN = humanVisits?.n ?? 0;
  const attributedN = attributedVisits?.n ?? 0;
  const attributedClicksN = attributedClicks?.n ?? 0;

  // Merge the two per-day rollups into one gap-filled series so the charts get
  // a continuous point per calendar day in the window (missing days -> zeros).
  const dailySeries = buildDailySeries(since, visitsByDay.results, clicksByDay.results);

  // Fill hours 0-23 so the histogram always has 24 columns even with sparse data.
  const hourMap = new Map(hourly.results.map((r) => [r.hour, r.n]));
  const hourly24 = Array.from({ length: 24 }, (_, h) => ({ hour: h, n: hourMap.get(h) ?? 0 }));

  const igN = igWebviewVisits?.n ?? 0;

  return {
    pageId,
    windowDays: sinceDays,
    windowStartDay: new Date(since).toISOString().slice(0, 10),
    totalVisits: visits?.n ?? 0,
    humanVisits: humanN,
    botVisits: botVisits?.n ?? 0,
    uniqueHumanVisitors: uniqueHumans?.n ?? 0,
    // Human visits we can trace to a channel, and the rest. The remainder is
    // not "people who typed the URL" — at this traffic level it is almost
    // entirely scanners that pass the UA classifier, so it belongs nowhere
    // near a conversion denominator.
    attributedVisits: attributedN,
    unattributedVisits: Math.max(0, humanN - attributedN),
    attributedClicks: attributedClicksN,
    // Taps only. `directHits` is the fetch traffic, kept visible so removing
    // it from the headline reads as a correction rather than a disappearance.
    totalClicks,
    directHits: directHits?.n ?? 0,
    clickThroughRate: humanN > 0 ? +(totalClicks / humanN * 100).toFixed(1) : 0,
    // CTR against attributed arrivals — the honest whole-funnel rate. Both
    // sides are the same cohort (see ATTRIBUTED_COHORT), so unlike the blended
    // rate it cannot exceed 100% or measure taps against scanners.
    attributedCtr: attributedN > 0 ? +((attributedClicksN / attributedN) * 100).toFixed(1) : 0,
    // Prefer these two over clickThroughRate when judging whether the page
    // works. The blended rate is kept for the daily series and back-compat.
    ctrByDevice: ctrByDevice.results.map((r) => ({
      ...r,
      ctr: r.visits > 0 ? +((r.clicks / r.visits) * 100).toFixed(1) : 0,
    })),
    igVisits: igCohort?.visits ?? 0,
    igClicks: igCohort?.clicks ?? 0,
    igCtr: igCohort && igCohort.visits > 0 ? +((igCohort.clicks / igCohort.visits) * 100).toFixed(1) : 0,
    igWebviewVisits: igN,
    igSharePct: humanN > 0 ? +((igN / humanN) * 100).toFixed(1) : 0,
    clicksByLink: clicksByLink.results,
    deviceSplit: deviceSplit.results,
    countrySplit: countrySplit.results,
    botTypeSplit: botTypeSplit.results,
    referrerSplit: referrerSplit.results,
    trafficSources: trafficSources.results,
    utmSourceSplit: utmSourceSplit.results,
    utmMediumSplit: utmMediumSplit.results,
    utmCampaignSplit: utmCampaignSplit.results,
    hourly: hourly24,
    dailySeries,
  };
}

export interface DailyPoint {
  day: string;
  humans: number;
  attributed: number;
  uniques: number;
  bots: number;
  clicks: number; // taps only
  attributedClicks: number; // taps by visitors whose arrival was attributed
  ctr: number; // attributedClicks / attributed * 100, 1 dp; 0 when none
}

// Produce one point per calendar day from `since` to today (UTC), joining the
// visit and click rollups and filling any day with no rows as zeros. A
// continuous series is what lets the dashboard draw a gap-free line chart.
//
// `since` arrives day-aligned from windowStart(), so every bucket here is a
// whole day and the series is exactly `sinceDays` points long. Today's bucket
// is still partial by definition — it is the only one, and it is the newest,
// where before the OLDEST bucket was silently partial too.
function buildDailySeries(
  since: number,
  visitsByDay: { day: string; humans: number; attributed: number; uniques: number; bots: number }[],
  clicksByDay: { day: string; clicks: number; attributedClicks: number }[]
): DailyPoint[] {
  const visitMap = new Map(visitsByDay.map((r) => [r.day, r]));
  const clickMap = new Map(clicksByDay.map((r) => [r.day, r]));

  const out: DailyPoint[] = [];
  const start = new Date(since);
  start.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let d = start; d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const v = visitMap.get(day);
    const c = clickMap.get(day);
    const attributed = v?.attributed ?? 0;
    const attributedClicks = c?.attributedClicks ?? 0;
    out.push({
      day,
      humans: v?.humans ?? 0,
      attributed,
      uniques: v?.uniques ?? 0,
      bots: v?.bots ?? 0,
      clicks: c?.clicks ?? 0,
      attributedClicks,
      // Against attributed visits, not raw humans — same denominator as the
      // headline, so the chart and the tiles can't disagree.
      ctr: attributed > 0 ? +((attributedClicks / attributed) * 100).toFixed(1) : 0,
    });
  }
  return out;
}
