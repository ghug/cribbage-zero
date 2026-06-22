-- Cribbage Zero data-bus schema (Cloudflare D1 / SQLite). Shards-only: the net lives on the GitHub
-- `net` branch, not in the bus. Apply:  wrangler d1 execute cribbage-zero --remote --file worker-api/schema.sql

CREATE TABLE IF NOT EXISTS shards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id  TEXT,
  created_at INTEGER NOT NULL,
  samples    TEXT    NOT NULL                      -- JSON array of self-play samples {x,pi,legal,z}
);

CREATE INDEX IF NOT EXISTS idx_shards_id ON shards (id);

-- The net is no longer stored in the bus (it lives on GitHub); drop the old single-row checkpoint table.
DROP TABLE IF EXISTS checkpoint;
