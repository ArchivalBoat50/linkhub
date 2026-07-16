-- linkhub analytics schema
-- page_id partitions every row so this same schema scales to multi-tenant
-- later without a migration — you'll just have more distinct page_id values.

-- Runtime page config. Moves the profile (name, handle, tagline, avatar,
-- background, links) out of the compile-time src/config.ts and into a row the
-- admin surface can edit without a redeploy. One row per page_id today; the
-- account_id column is already here so this is a routing change, not a
-- migration, when multi-tenant lands. config_json is a serialized PageConfig.
CREATE TABLE IF NOT EXISTS pages (
  page_id      TEXT PRIMARY KEY,
  account_id   TEXT,                    -- NULL until multi-tenant; FK to accounts later
  config_json  TEXT NOT NULL,           -- serialized PageConfig (see src/config.ts)
  updated_at   INTEGER NOT NULL         -- unix ms of last save
);

CREATE TABLE IF NOT EXISTS page_visits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         TEXT NOT NULL,
  ts              INTEGER NOT NULL,        -- unix ms
  is_bot          INTEGER NOT NULL DEFAULT 0,
  bot_type        TEXT,                    -- 'facebookexternalhit' | 'meta-externalagent' | 'meta-externalads' | 'other' | NULL
  is_ig_webview   INTEGER NOT NULL DEFAULT 0,
  country         TEXT,
  device          TEXT,                    -- 'mobile' | 'desktop' | 'tablet'
  browser         TEXT,
  referrer        TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  visitor_hash    TEXT                     -- sha256(ip + day + salt), never raw IP
);

CREATE TABLE IF NOT EXISTS link_clicks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         TEXT NOT NULL,
  link_id         TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  country         TEXT,
  device          TEXT,
  referrer        TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  visitor_hash    TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_page_ts   ON page_visits(page_id, ts);
CREATE INDEX IF NOT EXISTS idx_visits_bot       ON page_visits(page_id, is_bot, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_page_ts   ON link_clicks(page_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_link      ON link_clicks(page_id, link_id, ts);
