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

interface ClickRow {
  pageId: string;
  linkId: string;
  country: string | null;
  device: string;
  referrer: string | null;
  utm: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null };
  visitorHash: string;
}

export async function logClick(env: Env, row: ClickRow) {
  await env.DB.prepare(
    `INSERT INTO link_clicks
      (page_id, link_id, ts, country, device, referrer, utm_source, utm_medium, utm_campaign, visitor_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.pageId,
      row.linkId,
      Date.now(),
      row.country,
      row.device,
      row.referrer,
      row.utm.utm_source,
      row.utm.utm_medium,
      row.utm.utm_campaign,
      row.visitorHash
    )
    .run();
}

export async function getAnalyticsSummary(env: Env, pageId: string, sinceDays = 30) {
  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

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
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ?`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT visitor_hash) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
    env.DB.prepare(`SELECT link_id, COUNT(*) n FROM link_clicks WHERE page_id = ? AND ts >= ? GROUP BY link_id ORDER BY n DESC`).bind(pageId, since).all<{ link_id: string; n: number }>(),
    env.DB.prepare(`SELECT device, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY device ORDER BY n DESC`).bind(pageId, since).all<{ device: string; n: number }>(),
    env.DB.prepare(`SELECT country, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY country ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ country: string; n: number }>(),
    env.DB.prepare(`SELECT bot_type, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1 GROUP BY bot_type ORDER BY n DESC`).bind(pageId, since).all<{ bot_type: string; n: number }>(),
    env.DB.prepare(`SELECT referrer, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY referrer ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ referrer: string; n: number }>(),
    // Per-day visit rollup: human, unique-human, and bot counts in one pass.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch')) day,
              SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) humans,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN visitor_hash END) uniques,
              SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) bots
       FROM page_visits WHERE page_id = ? AND ts >= ?
       GROUP BY day ORDER BY day ASC`
    ).bind(pageId, since).all<{ day: string; humans: number; uniques: number; bots: number }>(),
    // Per-day click rollup, joined to the visit series by day below.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch')) day, COUNT(*) clicks
       FROM link_clicks WHERE page_id = ? AND ts >= ?
       GROUP BY day ORDER BY day ASC`
    ).bind(pageId, since).all<{ day: string; clicks: number }>(),
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
  ]);

  const totalClicks = clicksByLink.results.reduce((a, r) => a + r.n, 0);
  const humanN = humanVisits?.n ?? 0;

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
    totalVisits: visits?.n ?? 0,
    humanVisits: humanN,
    botVisits: botVisits?.n ?? 0,
    uniqueHumanVisitors: uniqueHumans?.n ?? 0,
    totalClicks,
    clickThroughRate: humanN > 0 ? +(totalClicks / humanN * 100).toFixed(1) : 0,
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
  uniques: number;
  bots: number;
  clicks: number;
  ctr: number; // clicks / humans * 100, rounded to 1 dp; 0 when no human visits
}

// Produce one point per calendar day from `since` to today (UTC), joining the
// visit and click rollups and filling any day with no rows as zeros. A
// continuous series is what lets the dashboard draw a gap-free line chart.
function buildDailySeries(
  since: number,
  visitsByDay: { day: string; humans: number; uniques: number; bots: number }[],
  clicksByDay: { day: string; clicks: number }[]
): DailyPoint[] {
  const visitMap = new Map(visitsByDay.map((r) => [r.day, r]));
  const clickMap = new Map(clicksByDay.map((r) => [r.day, r.clicks]));

  const out: DailyPoint[] = [];
  const start = new Date(since);
  start.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let d = start; d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const v = visitMap.get(day);
    const humans = v?.humans ?? 0;
    const clicks = clickMap.get(day) ?? 0;
    out.push({
      day,
      humans,
      uniques: v?.uniques ?? 0,
      bots: v?.bots ?? 0,
      clicks,
      ctr: humans > 0 ? +((clicks / humans) * 100).toFixed(1) : 0,
    });
  }
  return out;
}
