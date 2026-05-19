-- =====================================================
-- 005_ai_notes.sql : 나만의 AI 노트 시스템
-- WAL 제거, ALTER TABLE 안전 처리
-- =====================================================

-- ── AI 노트 피드백 테이블 ─────────────────────────────
CREATE TABLE IF NOT EXISTS note_feedbacks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id        INTEGER NOT NULL,
  user_id        INTEGER NOT NULL,
  feedback       TEXT    NOT NULL DEFAULT '',
  strengths      TEXT    DEFAULT '[]',
  improvements   TEXT    DEFAULT '[]',
  weak_areas     TEXT    DEFAULT '[]',
  interest_areas TEXT    DEFAULT '[]',
  score          INTEGER DEFAULT 0,
  created_at     DATETIME DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- ── 챗봇 상세 이력 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  session_id  TEXT    NOT NULL DEFAULT '',
  role        TEXT    NOT NULL DEFAULT 'user',
  message     TEXT    NOT NULL,
  subject     TEXT    DEFAULT '',
  model_ids   TEXT    DEFAULT '[]',
  with_quiz   INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT (datetime('now','localtime'))
);

-- ── 노트 태그 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (note_id, tag),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- ── AI 노트 생성 작업 큐 ──────────────────────────────
CREATE TABLE IF NOT EXISTS note_generation_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  model_ids      TEXT    NOT NULL DEFAULT '[]',
  status         TEXT    NOT NULL DEFAULT 'pending',
  result_note_id INTEGER DEFAULT NULL,
  error_msg      TEXT    DEFAULT NULL,
  ai_used        INTEGER DEFAULT 0,
  priority       INTEGER DEFAULT 5,
  created_at     DATETIME DEFAULT (datetime('now','localtime')),
  updated_at     DATETIME DEFAULT (datetime('now','localtime'))
);

-- ── 인덱스 ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_note_feedbacks_note     ON note_feedbacks(note_id);
CREATE INDEX IF NOT EXISTS idx_note_feedbacks_user     ON note_feedbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_user       ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_session    ON chat_history(session_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag           ON note_tags(tag);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status        ON note_generation_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority    ON note_generation_jobs(status, priority, created_at);