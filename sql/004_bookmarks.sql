PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_bookmarks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  model_id  INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, model_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
