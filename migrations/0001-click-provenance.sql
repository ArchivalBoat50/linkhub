-- 0001 — click provenance (`via`) + dedupe index.
--
-- Adds the column that separates a tap from a bare fetch of /go/<id>, and
-- backfills the rows written before it existed. See ClickVia in
-- src/analytics.ts for what the values mean.
--
-- Run once against production:
--   npm run db:migrate:remote
--
-- Idempotent apart from the ALTER, which errors with "duplicate column name"
-- if re-run. That is the intended signal that it has already been applied.

ALTER TABLE link_clicks ADD COLUMN via TEXT;

CREATE INDEX IF NOT EXISTS idx_clicks_dedupe ON link_clicks(page_id, link_id, visitor_hash, ts);

-- BACKFILL. Historical rows never recorded the escape mark, so the Referer is
-- all there is to go on. That is normally ambiguous — the iOS `b=i` escape hop
-- is a genuine tap that also arrives with no Referer — but it was checked
-- against this data before writing the rule: of the 25 Referer-less rows,
-- ZERO belonged to a visitor with an Instagram webview visit that day, so none
-- of them can be escape hops. For this table the mapping is exact. Re-verify
-- with that same query before trusting a blind backfill on any other dataset.

-- A tap: the Referer names a host we have served the page from. Both the live
-- custom domain and the retired workers.dev origin count — the workers.dev
-- rows predate the domain move and are real taps from that era.
UPDATE link_clicks
   SET via = 'page'
 WHERE via IS NULL
   AND referrer IS NOT NULL
   AND referrer <> ''
   AND (referrer LIKE 'http://example-links.com%'
     OR referrer LIKE 'https://example-links.com%'
     OR referrer LIKE 'http://linkhub.<account>.workers.dev%'
     OR referrer LIKE 'https://linkhub.<account>.workers.dev%');

-- Everything else: no Referer, or one pointing somewhere we never served.
-- Nobody had the page open — these were fetches, not taps.
UPDATE link_clicks SET via = 'direct' WHERE via IS NULL;
