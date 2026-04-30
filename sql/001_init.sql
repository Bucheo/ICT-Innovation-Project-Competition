PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO schema_info (key, value) VALUES ('schema_version', '001');