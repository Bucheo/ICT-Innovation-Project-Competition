// scripts/createAdmin.js
const bcrypt = require('bcryptjs');
const { db, runMigrations } = require('../db');

(async () => {
  try {
    runMigrations();

    const username = 'admin';          // 관리자 아이디
    const password = 'admin';      // 관리자 비번 (여기 바꿔도 됨)
    const email = null;

    const hashed = bcrypt.hashSync(password, 10);

    db.serialize(() => {
      // 1) 있나 확인
      db.get(`SELECT id FROM users WHERE username=?`, [username], (err, row) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }
        if (!row) {
          // 2) 없으면 새로 생성
          db.run(
            `INSERT INTO users (username, email, password, role)
             VALUES (?, ?, ?, 'admin')`,
            [username, email, hashed],
            function (err2) {
              if (err2) { console.error(err2); process.exit(1); }
              console.log(`✅ 관리자 생성: ${username} / ${password}`);
              process.exit(0);
            }
          );
        } else {
          // 3) 있으면 비번/역할 둘 다 갱신 (강제 재설정)
          db.run(
            `UPDATE users SET password=?, role='admin' WHERE username=?`,
            [hashed, username],
            function (err3) {
              if (err3) { console.error(err3); process.exit(1); }
              console.log(`✅ 관리자 갱신: ${username} / ${password}`);
              process.exit(0);
            }
          );
        }
      });
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
