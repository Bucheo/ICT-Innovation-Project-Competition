const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'app.db'); // 실행 중 바뀌지 않는 경로 const
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // data 폴더 보장

const db = new sqlite3.Database(DB_PATH);

// sql 폴더 안의 *.sql을 파일명 순으로 실행(001→002→...)
function runMigrations() {
  const sqlDir = path.join(__dirname, 'sql');
  const files = fs
    .readdirSync(sqlDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // "001_...", "002_..." 순서 보장

  db.serialize(() => {
    for (const file of files) {
      const full = path.join(sqlDir, file);
      const sql = fs.readFileSync(full, 'utf-8');
      db.exec(sql, (err) => {
        if (err) {
          console.error(`[DB][MIGRATION] ${file} 실패:`, err.message);
        } else {
          console.log(`[DB][MIGRATION] ${file} 적용 완료`);
        }
      });
    }
  });
}

module.exports = { db, runMigrations };