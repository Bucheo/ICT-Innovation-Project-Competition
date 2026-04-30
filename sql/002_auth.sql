PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  email       TEXT UNIQUE,
  password    TEXT NOT NULL,                 
  role        TEXT NOT NULL DEFAULT 'user',  
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);