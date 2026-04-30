const { db, runMigrations } = require('../db');

runMigrations();

// 마이그레이션이 비동기로 exec 되므로 약간의 딜레이 후 종료
// (간단 데모용. 운영에선 exec 콜백을 체이닝하거나 Promise화하는 게 깔끔)
setTimeout(() => {
  db.close();
  console.log('[DB] 마이그레이션 종료');
}, 500);