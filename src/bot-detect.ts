// Classifies each request as human, a known Meta crawler, or a generic bot.
// Only the "human" case ever triggers a real redirect.
//
// Why classification alone is NOT the whole security story (read this):
// - facebookexternalhit and the other Meta crawlers do not execute
//   JavaScript, so they never reach the JS-driven parts of the human page.
//   That is the primary barrier, and it is genuinely reliable for THOSE bots.
// - But User-Agent is spoofable, and a scraper can send a plain Chrome UA
//   and be classified "human". So we NEVER rely on classification alone to
//   protect the real destination URLs. The architecture also (a) never
//   serializes a real URL into any client-readable response, and (b) does
//   every redirect server-side through /go/<id>. Classification decides who
//   gets the clean bounce vs. the real redirect; it is one layer, not the
//   only one. See ARCHITECTURE.md "Threat model" for the full reasoning.
//
// ASN cross-check: a UA claiming to be a Meta crawler is only marked
// "verified" when request.cf.asn === 32934 (Meta's network). A Meta-looking
// UA from a non-Meta network is still treated as a crawler (fail safe), but
// tagged so you can see spoof attempts in analytics.

export type Classification =
  | { kind: "human"; isIgWebview: boolean }
  | { kind: "meta_crawler"; botType: string }
  | { kind: "generic_bot"; botType: string };

export const META_ASN = 32934;

const META_CRAWLER_PATTERNS: [RegExp, string][] = [
  [/facebookexternalhit/i, "facebookexternalhit"],
  [/facebookcatalog/i, "facebookcatalog"],
  [/meta-externalagent/i, "meta-externalagent"],
  [/meta-externalads/i, "meta-externalads"],
  [/meta-externalfetcher/i, "meta-externalfetcher"],
  [/meta-webindexer/i, "meta-webindexer"],
  [/facebot/i, "facebot"],
];

const GENERIC_BOT_PATTERNS: [RegExp, string][] = [
  [/bingbot|googlebot|duckduckbot|yandexbot|baiduspider|applebot|petalbot/i, "search-engine"],
  [/slackbot|twitterbot|discordbot|telegrambot|whatsapp|linkedinbot|pinterest/i, "social-preview"],
  [/headlesschrome|phantomjs|puppeteer|playwright|selenium/i, "headless-browser"],
  [/python-requests|python-urllib|curl\/|wget\/|scrapy|axios\/|go-http-client|okhttp|java\//i, "http-client"],
  [/\bbot\b|\bspider\b|\bcrawl(er)?\b|\bscraper\b/i, "generic-bot"],
];

// Matches "Instagram 300.0.0" style tokens — a REAL person in the IG in-app
// browser. Must NOT be treated as a bot. Checked before generic patterns so
// a stray "bot"-like substring can't misclassify a real IG visitor.
const IG_WEBVIEW_PATTERN = /\bInstagram\s+[\d.]+/i;

// Other known in-app webviews that are also real humans (FB, Messenger,
// TikTok, etc.). Same treatment as IG webview: human.
const OTHER_WEBVIEW_PATTERN = /\b(FBAN|FBAV|FB_IAB|Messenger|Line|MicroMessenger|TikTok|Musical_ly|Snapchat)\b/i;

export interface ClassifyOpts {
  // When true (local dev), treat any Meta-UA as verified even without a real
  // Meta ASN, so `wrangler dev` testing isn't all "-unverified-asn".
  trustMetaUAWithoutASN?: boolean;
}

export function classifyRequest(request: Request, opts: ClassifyOpts = {}): Classification {
  const ua = request.headers.get("User-Agent") || "";
  const cf = (request as unknown as { cf?: { asn?: number } }).cf;
  const asn = cf?.asn;

  // Network gate — runs BEFORE the human/webview checks on purpose. Any request
  // originating from Meta's own network (ASN 32934) is treated as a crawler
  // even when it carries a plain human browser UA. No real Instagram visitor is
  // ever on Meta's ASN — their traffic comes from mobile carriers / residential
  // ISPs — so this has zero false positives for actual fans while closing the
  // "human reviewer browsing from Meta's network" gap that UA detection alone
  // leaves open. A declared crawler keeps its specific botType; a plain browser
  // on Meta's net is tagged "meta-asn-browser" so analytics can tell "IG's
  // scanner fetched my link" apart from "someone at Meta opened it in a browser".
  if (asn === META_ASN) {
    const declared = META_CRAWLER_PATTERNS.find(([p]) => p.test(ua));
    return { kind: "meta_crawler", botType: declared ? declared[1] : "meta-asn-browser" };
  }

  // Real humans in in-app webviews first — highest priority, never a bot.
  if (IG_WEBVIEW_PATTERN.test(ua)) {
    return { kind: "human", isIgWebview: true };
  }
  if (OTHER_WEBVIEW_PATTERN.test(ua)) {
    return { kind: "human", isIgWebview: false };
  }

  for (const [pattern, botType] of META_CRAWLER_PATTERNS) {
    if (pattern.test(ua)) {
      const verified = asn === META_ASN || opts.trustMetaUAWithoutASN === true;
      return { kind: "meta_crawler", botType: verified ? botType : `${botType}-unverified-asn` };
    }
  }

  for (const [pattern, botType] of GENERIC_BOT_PATTERNS) {
    if (pattern.test(ua)) {
      return { kind: "generic_bot", botType };
    }
  }

  // Empty UA is suspicious — real browsers always send one. Treat as bot.
  if (ua.trim() === "") {
    return { kind: "generic_bot", botType: "empty-ua" };
  }

  return { kind: "human", isIgWebview: false };
}

export function deviceFromUA(ua: string): "mobile" | "tablet" | "desktop" {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobile|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

export function browserFromUA(ua: string): string {
  if (/instagram/i.test(ua)) return "instagram-webview";
  if (/\b(FBAN|FBAV|FB_IAB)\b/i.test(ua)) return "facebook-webview";
  if (/crios/i.test(ua)) return "chrome-ios";
  if (/fxios/i.test(ua)) return "firefox-ios";
  if (/edg\//i.test(ua)) return "edge";
  if (/chrome/i.test(ua)) return "chrome";
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return "safari";
  if (/firefox/i.test(ua)) return "firefox";
  return "other";
}
