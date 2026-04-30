// routes/bookmarks.js
const express = require('express');
const router = express.Router();

/* === index.js의 토큰 규칙과 SECRET을 맞춰야 함 === */
const DEMO_SECRET = process.env.DEMO_SECRET || 'dev-secret';  // index.js와 동일해야 함

function parseToken(token) {
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const [username, role, secret] = raw.split(':');
    if (secret !== DEMO_SECRET) return null;
    return { username, role };
  } catch { return null; }
}

/* username → DB user id */
async function getUserId(db, username) {
  const row = await db.get(`SELECT id FROM users WHERE username=?`, [username]);
  return row ? row.id : null;
}

/* 쿠키 기반 인증 미들웨어 (admin도 허용) */
function requireUser(db) {
  return async (req, res, next) => {
    const token = req.cookies?.ac_auth;
    const me = token && parseToken(token);
    if (!me) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const uid = await getUserId(db, me.username);
    if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

    req.user = { id: uid, username: me.username, role: me.role };
    next();
  };
}

module.exports = (db) => {
  // ⚠ DB 테이블명 확인: 'user_bookmarks' 또는 'bookmarks'
  const TBL = process.env.BM_TABLE || 'user_bookmarks';

  // GET /api/bookmarks  → { items: [modelId...] }
  router.get('/', requireUser(db), async (req, res) => {
    try {
      const rows = await db.all(
        `SELECT model_id FROM ${TBL} WHERE user_id = ? ORDER BY id DESC`,
        [req.user.id]
      );
      res.json({ items: rows.map(r => r.model_id) });
    } catch (e) {
      res.status(500).json({ error: 'DB_SELECT_FAILED' });
    }
  });

  // POST /api/bookmarks { modelId }
  router.post('/', requireUser(db), async (req, res) => {
    const { modelId } = req.body || {};
    if (!Number.isInteger(modelId)) {
      return res.status(400).json({ error: 'INVALID_MODEL_ID' });
    }
    try {
      await db.run(
        `INSERT OR IGNORE INTO ${TBL} (user_id, model_id) VALUES (?, ?)`,
        [req.user.id, modelId]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'DB_INSERT_FAILED' });
    }
  });

  // DELETE /api/bookmarks/:modelId
  router.delete('/:modelId', requireUser(db), async (req, res) => {
    const modelId = Number(req.params.modelId);
    if (!Number.isInteger(modelId)) {
      return res.status(400).json({ error: 'INVALID_MODEL_ID' });
    }
    try {
      await db.run(
        `DELETE FROM ${TBL} WHERE user_id = ? AND model_id = ?`,
        [req.user.id, modelId]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'DB_DELETE_FAILED' });
    }
  });

  return router;
};
