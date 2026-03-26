-- CS2 Stats Tracker Schema

CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,
  share_code     TEXT NOT NULL DEFAULT '',
  reservation_id TEXT,
  map            TEXT NOT NULL,
  date          INTEGER NOT NULL,  -- unix timestamp
  duration      INTEGER NOT NULL,  -- seconds
  result        TEXT NOT NULL CHECK(result IN ('W', 'L', 'T')),
  score_own     INTEGER NOT NULL,
  score_enemy   INTEGER NOT NULL,
  rounds_played INTEGER NOT NULL,
  kills         INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  assists       INTEGER NOT NULL DEFAULT 0,
  hs_count      INTEGER NOT NULL DEFAULT 0,
  adr           REAL NOT NULL DEFAULT 0,
  mvps          INTEGER NOT NULL DEFAULT 0,
  ping          INTEGER NOT NULL DEFAULT 0,
  demo_status   TEXT    NOT NULL DEFAULT 'pending'
    CHECK(demo_status IN ('pending','ok','expired','server_gone','parse_error','gcpd_ok'))
);

CREATE TABLE IF NOT EXISTS weapon_snapshots (
  snapshot_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_time     INTEGER NOT NULL,  -- unix timestamp
  weapon        TEXT NOT NULL,
  shots         INTEGER NOT NULL DEFAULT 0,
  hits          INTEGER NOT NULL DEFAULT 0,
  kills         INTEGER NOT NULL DEFAULT 0,
  hs            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_log (
  sync_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,  -- unix timestamp
  last_share_code TEXT NOT NULL,
  matches_fetched INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK(status IN ('ok', 'error')),
  error_message   TEXT
);

-- Phase 2: GSI round data
CREATE TABLE IF NOT EXISTS gsi_rounds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         TEXT NOT NULL,
  round_number     INTEGER NOT NULL,
  side             TEXT NOT NULL CHECK(side IN ('CT', 'T')),
  buy_type         TEXT NOT NULL CHECK(buy_type IN ('eco', 'force', 'full', 'pistol', 'unknown')),
  spend            INTEGER NOT NULL DEFAULT 0,
  start_money      INTEGER NOT NULL DEFAULT 0,
  kills_this_round INTEGER NOT NULL DEFAULT 0,
  died             INTEGER NOT NULL DEFAULT 0,  -- 0 or 1
  clutch_situation INTEGER NOT NULL DEFAULT 0,  -- 0 or 1
  clutch_won       INTEGER NOT NULL DEFAULT 0,  -- 0 or 1
  FOREIGN KEY (match_id) REFERENCES matches(match_id)
);

-- Derived view: per-session weapon deltas between consecutive snapshots
CREATE VIEW IF NOT EXISTS weapon_stats_delta AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY weapon ORDER BY sync_time) AS rn,
    LAG(shots)  OVER (PARTITION BY weapon ORDER BY sync_time) AS prev_shots,
    LAG(hits)   OVER (PARTITION BY weapon ORDER BY sync_time) AS prev_hits,
    LAG(kills)  OVER (PARTITION BY weapon ORDER BY sync_time) AS prev_kills,
    LAG(hs)     OVER (PARTITION BY weapon ORDER BY sync_time) AS prev_hs,
    LAG(sync_time) OVER (PARTITION BY weapon ORDER BY sync_time) AS prev_sync_time
  FROM weapon_snapshots
)
SELECT
  snapshot_id,
  sync_time,
  prev_sync_time,
  weapon,
  shots  - COALESCE(prev_shots, 0)  AS delta_shots,
  hits   - COALESCE(prev_hits,  0)  AS delta_hits,
  kills  - COALESCE(prev_kills, 0)  AS delta_kills,
  hs     - COALESCE(prev_hs,    0)  AS delta_hs,
  CASE WHEN (shots - COALESCE(prev_shots, 0)) > 0
    THEN ROUND(CAST(hits - COALESCE(prev_hits, 0) AS REAL) / (shots - COALESCE(prev_shots, 0)) * 100, 1)
    ELSE 0
  END AS accuracy_pct,
  CASE WHEN (kills - COALESCE(prev_kills, 0)) > 0
    THEN ROUND(CAST(hs - COALESCE(prev_hs, 0) AS REAL) / (kills - COALESCE(prev_kills, 0)) * 100, 1)
    ELSE 0
  END AS hs_pct
FROM ranked
WHERE rn > 1
  AND (shots - COALESCE(prev_shots, 0)) > 0;
