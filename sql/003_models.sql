-- sql/003_models.sql
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  subject TEXT,
  thumb TEXT,              -- '/uploads/파일명.ext' 같은 상대경로
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
