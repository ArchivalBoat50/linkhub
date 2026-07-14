export interface Env {
  DB: D1Database;
  PAGE_ID: string;
  MODEL_NAME: string;
  DASHBOARD_TOKEN: string;
  VISITOR_SALT: string;
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

  const [visits, humanVisits, botVisits, uniqueHumans, clicksByLink, deviceSplit, countrySplit, botTypeSplit, referrerSplit, dailySeries] =
    await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ?`).bind(pageId, since).first<{ n: number }>(),
      env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
      env.DB.prepare(`SELECT COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1`).bind(pageId, since).first<{ n: number }>(),
      env.DB.prepare(`SELECT COUNT(DISTINCT visitor_hash) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0`).bind(pageId, since).first<{ n: number }>(),
      env.DB.prepare(`SELECT link_id, COUNT(*) n FROM link_clicks WHERE page_id = ? AND ts >= ? GROUP BY link_id ORDER BY n DESC`).bind(pageId, since).all<{ link_id: string; n: number }>(),
      env.DB.prepare(`SELECT device, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY device ORDER BY n DESC`).bind(pageId, since).all<{ device: string; n: number }>(),
      env.DB.prepare(`SELECT country, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY country ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ country: string; n: number }>(),
      env.DB.prepare(`SELECT bot_type, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 1 GROUP BY bot_type ORDER BY n DESC`).bind(pageId, since).all<{ bot_type: string; n: number }>(),
      env.DB.prepare(`SELECT referrer, COUNT(*) n FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0 GROUP BY referrer ORDER BY n DESC LIMIT 10`).bind(pageId, since).all<{ referrer: string; n: number }>(),
      env.DB.prepare(
        `SELECT strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch')) day, COUNT(*) n
         FROM page_visits WHERE page_id = ? AND ts >= ? AND is_bot = 0
         GROUP BY day ORDER BY day ASC`
      ).bind(pageId, since).all<{ day: string; n: number }>(),
    ]);

  const totalClicks = clicksByLink.results.reduce((a, r) => a + r.n, 0);
  const humanN = humanVisits?.n ?? 0;

  return {
    pageId,
    windowDays: sinceDays,
    totalVisits: visits?.n ?? 0,
    humanVisits: humanN,
    botVisits: botVisits?.n ?? 0,
    uniqueHumanVisitors: uniqueHumans?.n ?? 0,
    totalClicks,
    clickThroughRate: humanN > 0 ? +(totalClicks / humanN * 100).toFixed(1) : 0,
    clicksByLink: clicksByLink.results,
    deviceSplit: deviceSplit.results,
    countrySplit: countrySplit.results,
    botTypeSplit: botTypeSplit.results,
    referrerSplit: referrerSplit.results,
    dailySeries: dailySeries.results,
  };
}
