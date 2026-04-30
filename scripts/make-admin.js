const bcrypt = require('bcryptjs');
const { db } = require('../db');

const username = 'admin';
const email = 'admin@example.com';
const password = 'admin123'; // 데모용 비밀번호
const hash = bcrypt.hashSync(password, 10); // 단방향 해시

// 이미 있으면 업데이트(OR REPLACE) 동작: id를 유지하면서 role/비번 갱신
db.run(
  `INSERT INTO users (username, email, password, role)
     VALUES (?, ?, ?, 'admin')
   ON CONFLICT(username) DO UPDATE SET
     email=excluded.email,
     password=excluded.password,
     role='admin'`,
  [username, email, hash],
  function (err) {
    if (err) {
      console.error('[make-admin] 실패:', err.message);
    } else {
      console.log('[make-admin] 완료: username=admin, pw=admin123');
    }
    db.close();
  }
);