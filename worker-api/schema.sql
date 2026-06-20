-- Cribbage Zero data-bus schema (Cloudflare D1 / SQLite).
-- Apply: wrangler d1 execute cribbage-zero --file worker-api/schema.sql

CREATE TABLE IF NOT EXISTS checkpoint (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  iter       INTEGER NOT NULL,
  net        TEXT    NOT NULL,                     -- JSON: {iter,nIn,nHid,nPol,W1,b1,Wv,bv,Wp,bp}
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id  TEXT,
  created_at INTEGER NOT NULL,
  samples    TEXT    NOT NULL                      -- JSON array of self-play samples {x,pi,legal,z}
);

CREATE INDEX IF NOT EXISTS idx_shards_id ON shards (id);
