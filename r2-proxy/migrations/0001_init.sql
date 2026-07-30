-- SareChild edge ops database (Cloudflare D1)
-- Fast read path + redundancy cache alongside Firebase Firestore.

CREATE TABLE IF NOT EXISTS fleet_snapshots (
  family_id TEXT NOT NULL,
  registered_devices INTEGER NOT NULL DEFAULT 0,
  online_devices INTEGER NOT NULL DEFAULT 0,
  offline_devices INTEGER NOT NULL DEFAULT 0,
  guardians INTEGER NOT NULL DEFAULT 0,
  alerts_last_24h INTEGER NOT NULL DEFAULT 0,
  critical_alerts_last_24h INTEGER NOT NULL DEFAULT 0,
  pending_commands INTEGER NOT NULL DEFAULT 0,
  latest_heartbeat_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'firebase',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (family_id)
);

CREATE TABLE IF NOT EXISTS device_heartbeats (
  family_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  child_name TEXT,
  last_heartbeat_ms INTEGER NOT NULL,
  battery_percent INTEGER,
  monitoring_active INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (family_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_heartbeats_family_hb
  ON device_heartbeats (family_id, last_heartbeat_ms DESC);

CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  r2_status TEXT,
  d1_status TEXT,
  kv_status TEXT,
  firebase_status TEXT,
  latency_ms INTEGER,
  detail_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_events_generated
  ON health_events (generated_at_ms DESC);
