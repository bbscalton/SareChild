-- Storage quota bookkeeping for TCD / R2 PUT enforcement
CREATE TABLE IF NOT EXISTS storage_quotas (
  family_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  max_bytes INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
