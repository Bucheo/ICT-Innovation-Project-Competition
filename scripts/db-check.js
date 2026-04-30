// DB에서 users 목록을 조회해 정상 생성/권한을 빠르게 확인
const { db, runMigrations } = require('../db'); // 불변 연결/경로 → const

// 혹시 적용 안 됐으면 마이그레이션 재확인
runMigrations();

db.serialize(() => {
  // PRAGMA 확인(외래키 켜졌는지)
  db.get(`PRAGMA foreign_keys`, (e, row) => {
    if (e) console.error('[check] PRAGMA error:', e.message);
    else console.log('[check] foreign_keys =', row ? Object.values(row)[0] : '(unknown)');
  });

  // users 테이블 덤프
  db.all(
    `SELECT id, username, email, role, datetime(created_at) AS created_at
     FROM users
     ORDER BY id`,
    [],
    (err, rows) => {
      if (err) {
        console.error('[check] users error:', err.message);
      } else {
        console.log('=== users ===');
        console.table(rows);
      }
      db.close();
    }
  );
});