const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[DB] 연결 실패:', err.message);
    console.error('[DB] data/ 폴더 쓰기 권한을 확인하세요:', DB_PATH);
    process.exit(1);
  }
  console.log('[DB] 연결 성공:', DB_PATH);
});

// ── 안전한 ALTER TABLE (이미 있으면 무시) ─────────────────────────
function safeAddColumn(table, column, definition) {
  return new Promise((resolve) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (err) => {
      // "duplicate column name" 에러는 정상 → 무시
      if (err && !err.message.includes('duplicate column')) {
        console.warn(`[DB] ALTER TABLE ${table} ADD COLUMN ${column}:`, err.message);
      }
      resolve();
    });
  });
}

// ── 마이그레이션: sql/*.sql 순서대로 실행 ────────────────────────
function runMigrations() {
  const sqlDir = path.join(__dirname, 'sql');
  const files  = fs.readdirSync(sqlDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // 각 파일을 순차 실행 (serialize)
  db.serialize(() => {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(sqlDir, file), 'utf-8');
      db.exec(sql, (err) => {
        if (err) console.error(`[DB][MIGRATION] ${file} 실패:`, err.message);
        else      console.log(`[DB][MIGRATION] ${file} 적용 완료`);
      });
    }

    // notes 테이블 컬럼 추가 (ALTER TABLE 오류 없이 안전 처리)
    db.run('SELECT 1', async () => {
      await safeAddColumn('notes', 'updated_at', "DATETIME DEFAULT (datetime('now','localtime'))");
      await safeAddColumn('notes', 'tags',       "TEXT DEFAULT '[]'");
      await safeAddColumn('notes', 'view_count', 'INTEGER DEFAULT 0');
      await safeAddColumn('notes', 'ai_model',   "TEXT DEFAULT ''");

      // note_feedbacks 컬럼 추가 (이전 버전 호환)
      await safeAddColumn('note_feedbacks', 'weak_areas',     "TEXT DEFAULT '[]'");
      await safeAddColumn('note_feedbacks', 'interest_areas', "TEXT DEFAULT '[]'");

      console.log('[DB] 컬럼 마이그레이션 완료');
    });
  });
}

module.exports = { db, runMigrations };