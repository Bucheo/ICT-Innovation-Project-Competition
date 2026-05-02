const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const sharp = require('sharp');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { db, runMigrations } = require('./db');
// 🍑 Python AI 서버 프록시용
const axios = require('axios');

const app = express();
const PORT = 3000;
const PYTHON_AI_SERVER = 'http://127.0.0.1:8000'; // 🍑 IPv4 강제 (localhost → 127.0.0.1)

/* ================== 경로 상수 ================== */
const DATA_DIR = path.join(__dirname, 'data');
const MODELS_JSON = path.join(DATA_DIR, 'models.json');
const CATEGORIES_JSON = path.join(DATA_DIR, 'categories.json');
const UPLOADS_ROOT = path.join(__dirname, 'uploads');
const UPLOADS_MODELS_DIR = path.join(UPLOADS_ROOT, 'models'); // (미사용이어도 경로 보존)
const UPLOADS_THUMBS_DIR = path.join(UPLOADS_ROOT, 'thumbs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
fs.mkdirSync(UPLOADS_MODELS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_THUMBS_DIR, { recursive: true });

/* ================== 미들웨어 ================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // ✅ 라우트보다 먼저
app.use('/uploads', express.static(UPLOADS_ROOT));
app.use(express.static(path.join(__dirname, 'public')));

/* ================== 초기 마이그레이션 ================== */
runMigrations();
db.exec(`
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, model_id) ON CONFLICT IGNORE
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  subject TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  message TEXT NOT NULL,
  subject TEXT,
  with_quiz INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/* ================== 인증 / 권한 ================== */
const DEMO_SECRET = 'dev-secret';
function makeToken(username, role) {
    return Buffer.from(`${username}:${role}:${DEMO_SECRET}`).toString('base64');
}
function parseToken(token) {
    try {
        const raw = Buffer.from(token, 'base64').toString('utf-8');
        const [username, role, secret] = raw.split(':');
        if (secret !== DEMO_SECRET) return null;
        return { username, role };
    } catch {
        return null;
    }
}
function currentUser(req) {
    const token = req.cookies?.ac_auth;
    if (!token) return null;
    return parseToken(token);
}
function requireLogin(req, res, next) {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: 'UNAUTHORIZED' });
    req.me = me; // admin도 통과
    next();
}
function requireAdmin(req, res, next) {
    const me = currentUser(req);
    if (!me || me.role !== 'admin')
        return res.status(403).json({ error: 'ADMIN_ONLY' });
    req.user = me;
    next();
}
async function getUserId(username) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT id FROM users WHERE username=?`,
            [username],
            (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.id : null);
            }
        );
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

/* ================== 업로드 설정(썸네일) ================== */
const storageThumb = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_THUMBS_DIR),
    filename: (_req, file, cb) => {
        const ts = Date.now();
        const safe = (file.originalname || 'image').replace(/\s+/g, '_');
        cb(null, `${ts}_${safe}`);
    },
});
const uploadThumb = multer({
    storage: storageThumb,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* ================== 썸네일(oEmbed 우선, 실패 시 SVG) ================== */
function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}
const PALETTE = [
    ['#4e77ba', '#bc2c3c'],
    ['#3aa675', '#0e7490'],
    ['#7c3aed', '#fb7185'],
    ['#f59e0b', '#ef4444'],
    ['#2563eb', '#16a34a'],
    ['#9333ea', '#3b82f6'],
    ['#0ea5e9', '#22c55e'],
    ['#ef4444', '#f97316'],
];
function makeSVG({ title = 'Untitled', description = '', key = 'x' }) {
    const [c1, c2] = PALETTE[hashCode(String(key)) % PALETTE.length];
    const W = 640,
        H = 480;
    const esc = (s) =>
        (s || '').replace(
            /[&<>"]/g,
            (c) =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
        );
    const T1 = esc(title).slice(0, 40),
        D1 = esc(description).slice(0, 60);
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/><g fill="#fff" font-family="Pretendard,system-ui,-apple-system,Segoe UI,Roboto,Noto Sans KR">
  <text x="24" y="56" font-size="34" font-weight="700">${T1}</text>${
        D1 ? `<text x="24" y="92" font-size="16" opacity=".9">${D1}</text>` : ''
    }</g></svg>`;
}
function httpGetJson(urlStr) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(
            {
                hostname: u.hostname,
                path: u.pathname + (u.search || ''),
                protocol: u.protocol,
                headers: {
                    'User-Agent': 'ModelCatalogBot/1.0',
                    Accept: 'application/json',
                    'Accept-Encoding': 'identity',
                },
            },
            (res) => {
                let data = '';
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
                    return httpGetJson(res.headers.location)
                        .then(resolve)
                        .catch(reject);
                }
                if (res.statusCode !== 200)
                    return reject(new Error('HTTP ' + res.statusCode));
                res.setEncoding('utf8');
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
    });
}
function downloadToFile(fileUrl, absDest) {
    return new Promise((resolve, reject) => {
        const u = new URL(fileUrl);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(
            {
                hostname: u.hostname,
                path: u.pathname + (u.search || ''),
                protocol: u.protocol,
                headers: {
                    'User-Agent': 'ModelCatalogBot/1.0',
                    Accept: 'image/*;q=0.9,*/*;q=0.1',
                    'Accept-Encoding': 'identity',
                },
            },
            (res) => {
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
                    return downloadToFile(res.headers.location, absDest)
                        .then(resolve)
                        .catch(reject);
                }
                if (res.statusCode !== 200)
                    return reject(new Error('HTTP ' + res.statusCode));
                const file = fs.createWriteStream(absDest);
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(true)));
                file.on('error', reject);
            }
        );
        req.on('error', reject);
    });
}
function extractSketchfabUid(modelUrl) {
    try {
        const parts = modelUrl.split('/').filter(Boolean);
        const last = parts.pop() || '';
        return last.includes('-') ? last.split('-').pop() : last;
    } catch {
        return null;
    }
}
async function fetchSketchfabThumb(modelUrl) {
    const uid = extractSketchfabUid(modelUrl);
    const candidates = [
        modelUrl,
        uid ? `https://sketchfab.com/models/${uid}` : null,
    ].filter(Boolean);
    for (const pageUrl of candidates) {
        const oembed = `https://sketchfab.com/oembed?format=json&url=${encodeURIComponent(
            pageUrl
        )}`;
        try {
            const data = await httpGetJson(oembed);
            const t = data.thumbnail_url || data.thumbnail_url_with_play_button;
            if (t) return t;
        } catch (e) {
            console.warn('[oEmbed fail]', pageUrl, e.message);
        }
    }
    return null;
}
async function ensureAutoThumb({
    uploadedPath,
    title,
    description,
    key,
    modelUrl,
}) {
    try {
        if (uploadedPath) return uploadedPath;
        if (modelUrl && /sketchfab\.com/i.test(modelUrl)) {
            const remote = await fetchSketchfabThumb(modelUrl);
            if (remote) {
                const fname = `${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2)}.jpg`;
                const abs = path.join(UPLOADS_THUMBS_DIR, fname);
                await downloadToFile(remote, abs);
                return `/uploads/thumbs/${fname}`;
            }
        }
    } catch (e) {
        console.warn('[ensureAutoThumb:oEmbed]', e.message);
    }
    // 폴백: SVG 생성 → PNG 변환
    const svg = makeSVG({ title, description, key });
    const fname = `${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
    await sharp(Buffer.from(svg))
        .png()
        .toFile(path.join(UPLOADS_THUMBS_DIR, fname));
    return `/uploads/thumbs/${fname}`;
}

/* ================== 북마크 API ================== */
app.get('/api/bookmarks', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        db.all(
            `SELECT model_id FROM bookmarks WHERE user_id=? ORDER BY id DESC`,
            [uid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const ids = rows.map((r) => Number(r.model_id));

                // ✅ 확장 응답 지원
                if (String(req.query.expand) === '1') {
                    const all = readJson(MODELS_JSON, []);
                    const items = all.filter((m) => ids.includes(Number(m.id)));
                    return res.json({ items });
                }
                res.json({ items: ids });
            }
        );
    } catch {
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
});
app.post('/api/bookmarks', requireLogin, async (req, res) => {
    try {
        const { modelId } = req.body || {};
        if (!modelId)
            return res.status(400).json({ error: 'MODEL_ID_REQUIRED' });
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });
        db.run(
            `INSERT OR IGNORE INTO bookmarks (user_id, model_id) VALUES (?, ?)`,
            [uid, Number(modelId)],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true });
            }
        );
    } catch {
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
});
app.delete('/api/bookmarks/:modelId', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });
        const mid = Number(req.params.modelId);
        db.run(
            `DELETE FROM bookmarks WHERE user_id=? AND model_id=?`,
            [uid, mid],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true });
            }
        );
    } catch {
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
});

/* ================== 관리자 시드 ================== */
(function seedAdmin() {
    db.get(
        `SELECT id FROM users WHERE username='admin' AND role='admin'`,
        (err, row) => {
            if (err)
                return console.error('[SEED] admin lookup fail:', err.message);
            if (row) return;
            const pw = process.env.ADMIN_PASSWORD || 'admin';
            const hashed = bcrypt.hashSync(pw, 10);
            db.run(
                `INSERT INTO users (username, email, password, role) VALUES ('admin', NULL, ?, 'admin')`,
                [hashed],
                (e) =>
                    e
                        ? console.error('[SEED] admin create fail:', e.message)
                        : console.log(
                              '✓ admin user seeded (username=admin, password=' +
                                  pw +
                                  ')'
                          )
            );
        }
    );
})();

/* ================== Auth ================== */
app.post('/api/auth/signup', (req, res) => {
    const { username, email, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: 'username, password 필수' });
    const hashed = bcrypt.hashSync(password, 10);
    db.run(
        `INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, 'user')`,
        [username, email || null, hashed],
        function (err) {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ ok: true, userId: this.lastID });
        }
    );
});
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    db.get(
        `SELECT id, username, password, role FROM users WHERE username = ?`,
        [username],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row)
                return res.status(401).json({ error: '존재하지 않는 계정' });
            if (!bcrypt.compareSync(password, row.password))
                return res.status(401).json({ error: '비밀번호 불일치' });
            const token = makeToken(row.username, row.role);
            res.cookie('ac_auth', token, {
                httpOnly: false,
                sameSite: 'Lax',
                path: '/',
            });
            res.json({ ok: true, role: row.role });
        }
    );
});
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('ac_auth');
    res.json({ ok: true });
});
app.get('/api/auth/whoami', (req, res) => {
    const me = currentUser(req);
    res.json({ ok: !!me, user: me || null });
});

/* ================== 유틸(JSON I/O) ================== */
function readJson(file, fallback = []) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return fallback;
    }
}
function writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
}

/* ================== Models API (조회) ================== */
app.get('/api/models', (_req, res) => {
    const list = readJson(MODELS_JSON, []);
    res.json({ items: list });
});
app.get('/api/models/:id', (req, res) => {
    const id = Number(req.params.id);
    const list = readJson(MODELS_JSON, []);
    const item = list.find((m) => Number(m.id) === id);
    if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(item);
});

/* ================== 🍑 AI 의미 검색 API (Python 서버 프록시) ================== */
// IPv4 강제용 에이전트
const httpAgentV4 = new http.Agent({ family: 4 });

app.get('/api/semantic_search', async (req, res) => {
    try {
        const { q, k = 5 } = req.query;

        if (!q) {
            return res.status(400).json({ error: '검색어를 입력해주세요' });
        }

        // 🍑 Python AI 서버로 프록시
        const response = await axios.get(
            `${PYTHON_AI_SERVER}/semantic_search`,
            {
                params: { q, k },
                timeout: 5000, // 5초 타임아웃
                httpAgent: httpAgentV4, // ← IPv4 사용
            }
        );

        res.json(response.data);
    } catch (error) {
        console.error('🍑 AI 검색 에러:', error.message);

        // 🍑 Python 서버가 꺼져있을 때 graceful fallback
        if (error.code === 'ECONNREFUSED') {
            return res.json({
                error: 'AI 서버가 실행 중이지 않습니다',
                results: [],
                fallback: true,
            });
        }

        res.status(500).json({
            error: 'AI 검색 중 오류 발생',
            details: error.message,
            results: [],
        });
    }
});

app.post('/api/chat', requireLogin, async (req, res) => {
    try {
        const { message, subject = '', withQuiz = false } = req.body || {};

        if (!message || !String(message).trim()) {
            return res.status(400).json({ error: '메시지를 입력해주세요' });
        }

        const uid = await getUserId(req.me.username);
        dbRun(
            `INSERT INTO chat_logs (user_id, message, subject, with_quiz) VALUES (?, ?, ?, ?)`,
            [
                uid,
                String(message).trim(),
                String(subject || ''),
                withQuiz ? 1 : 0,
            ]
        ).catch((err) => console.warn('[chat_logs]', err.message));

        const response = await axios.post(
            `${PYTHON_AI_SERVER}/chat`,
            {
                message: String(message).trim(),
                subject,
                with_quiz: Boolean(withQuiz),
            },
            {
                timeout: 120000,
                httpAgent: httpAgentV4,
            }
        );

        res.json(response.data);
    } catch (error) {
        console.error('챗봇 오류:', error.message);

        if (error.code === 'ECONNREFUSED') {
            return res.status(503).json({
                error: 'AI 서버가 실행 중이 아닙니다. npm run ai를 먼저 실행해주세요.',
            });
        }

        res.status(error.response?.status || 500).json({
            error:
                error.response?.data?.error ||
                error.response?.data?.detail ||
                '챗봇 답변 생성 중 오류가 발생했습니다',
        });
    }
});

app.post('/api/notes', requireLogin, async (req, res) => {
    try {
        const { title, content, subject = '' } = req.body || {};
        const cleanTitle = String(title || '').trim();
        const cleanContent = String(content || '').trim();
        if (!cleanTitle || !cleanContent) {
            return res.status(400).json({ error: 'TITLE_AND_CONTENT_REQUIRED' });
        }

        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        db.run(
            `INSERT INTO notes (user_id, title, content, subject) VALUES (?, ?, ?, ?)`,
            [uid, cleanTitle, cleanContent, String(subject || '')],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true, id: this.lastID });
            }
        );
    } catch {
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
});

app.get('/api/notes', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const rows = await dbAll(
            `SELECT id, title, content, subject, created_at
               FROM notes
              WHERE user_id=?
              ORDER BY id DESC`,
            [uid]
        );
        res.json({ items: rows });
    } catch (err) {
        res.status(500).json({ error: err.message || 'SERVER_ERROR' });
    }
});

app.put('/api/notes/:id', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const id = Number(req.params.id);
        const { title, content, subject = '' } = req.body || {};
        const cleanTitle = String(title || '').trim();
        const cleanContent = String(content || '').trim();

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'INVALID_NOTE_ID' });
        }
        if (!cleanTitle || !cleanContent) {
            return res.status(400).json({ error: 'TITLE_AND_CONTENT_REQUIRED' });
        }

        const result = await dbRun(
            `UPDATE notes
                SET title=?, content=?, subject=?
              WHERE id=? AND user_id=?`,
            [cleanTitle, cleanContent, String(subject || ''), id, uid]
        );

        if (!result.changes) return res.status(404).json({ error: 'NOTE_NOT_FOUND' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'SERVER_ERROR' });
    }
});

app.delete('/api/notes/:id', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'INVALID_NOTE_ID' });
        }

        const result = await dbRun(`DELETE FROM notes WHERE id=? AND user_id=?`, [
            id,
            uid,
        ]);
        if (!result.changes) return res.status(404).json({ error: 'NOTE_NOT_FOUND' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'SERVER_ERROR' });
    }
});

app.post('/api/notes/generate', requireLogin, async (req, res) => {
    try {
        const uid = await getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const selectedIds = [
            ...new Set(
                ((req.body || {}).modelIds || [])
                    .map((id) => Number(id))
                    .filter((id) => Number.isInteger(id) && id > 0)
            ),
        ];
        if (!selectedIds.length) {
            return res.status(400).json({ error: 'BOOKMARK_SELECTION_REQUIRED' });
        }

        const models = readJson(MODELS_JSON, []);
        const placeholders = selectedIds.map(() => '?').join(',');
        const bookmarkRows = await dbAll(
            `SELECT model_id, created_at
               FROM bookmarks
              WHERE user_id=? AND model_id IN (${placeholders})
              ORDER BY id DESC`,
            [uid, ...selectedIds]
        );
        if (!bookmarkRows.length) {
            return res.status(400).json({ error: 'SELECTED_BOOKMARK_NOT_FOUND' });
        }

        const chatRows = await dbAll(
            `SELECT message, subject, with_quiz, created_at
               FROM chat_logs
              WHERE user_id=?
              ORDER BY id DESC
              LIMIT 80`,
            [uid]
        );

        const bookmarks = bookmarkRows
            .map((row) => {
                const model = models.find((m) => Number(m.id) === Number(row.model_id));
                if (!model) return null;
                return {
                    title: model.title,
                    description: model.description || '',
                    subject: model.subject || '',
                };
            })
            .filter(Boolean);
        const selectedSubjects = new Set(
            bookmarks.map((model) => model.subject).filter(Boolean)
        );
        const keywordSource = bookmarks
            .map((model) => `${model.title || ''} ${model.description || ''}`)
            .join(' ');
        const keywords = [
            ...new Set(
                keywordSource
                    .toLowerCase()
                    .replace(/[^\w가-힣\s]/g, ' ')
                    .split(/\s+/)
                    .map((word) => word.trim())
                    .filter((word) => word.length >= 2)
            ),
        ].slice(0, 24);
        const relatedChatRows = chatRows
            .filter((row) => {
                const message = String(row.message || '').toLowerCase();
                return (
                    (row.subject && selectedSubjects.has(row.subject)) ||
                    keywords.some((keyword) => message.includes(keyword))
                );
            })
            .slice(0, 12);

        const titleBase =
            bookmarks.length === 1
                ? bookmarks[0].title
                : `${bookmarks[0].title} 외 ${bookmarks.length - 1}개`;
        const title = `AI 학습 노트 - ${titleBase}`;
        const fallback = [
            '# 핵심 개념',
            bookmarks.length
                ? bookmarks
                      .map((m) => `- ${m.title}: ${m.description || '북마크한 개념'}`)
                      .join('\n')
                : '- 아직 북마크한 개념이 없습니다.',
            '',
            '# 최근 질문에서 정리할 내용',
            relatedChatRows.length
                ? relatedChatRows.map((row) => `- ${row.message}`).join('\n')
                : '- 선택한 개념과 직접 관련된 챗봇 질문 기록이 아직 없습니다.',
            '',
            '# 다시 확인할 개념',
            relatedChatRows.some((row) => row.with_quiz)
                ? relatedChatRows
                      .filter((row) => row.with_quiz)
                      .map((row) => `- 퀴즈로 확인 요청: ${row.message}`)
                      .join('\n')
                : '- 선택한 개념과 관련된 퀴즈 요청 기록이 생기면 이곳에 복습 후보가 정리됩니다.',
        ].join('\n');

        let content = fallback;
        let aiUsed = false;

        if (bookmarks.length || relatedChatRows.length) {
            try {
                const prompt = [
                    '사용자의 개인 학습 노트를 한국어로 작성해 주세요.',
                    '사용자가 선택한 3D 학습 개념만 중심으로 정리합니다.',
                    '챗봇 대화는 선택한 개념과 관련 있는 질문만 참고 자료로 사용합니다.',
                    '형식은 다음 섹션을 포함하세요: 핵심 개념, 질문으로 보강한 내용, 다시 확인할 개념, 사용자가 직접 고칠 부분.',
                    '너무 길지 않게 bullet 위주로 작성하고, 확인되지 않은 오답은 "다시 확인할 개념"으로 표현하세요.',
                    '',
                    `선택한 북마크: ${JSON.stringify(bookmarks)}`,
                    `관련 챗봇 질문: ${JSON.stringify(relatedChatRows)}`,
                ].join('\n');

                const response = await axios.post(
                    `${PYTHON_AI_SERVER}/chat`,
                    { message: prompt, subject: '', with_quiz: false },
                    { timeout: 120000, httpAgent: httpAgentV4 }
                );
                if (response.data?.answer) {
                    content = String(response.data.answer).trim();
                    aiUsed = true;
                }
            } catch (err) {
                console.warn('[notes/generate] AI fallback:', err.message);
            }
        }

        const result = await dbRun(
            `INSERT INTO notes (user_id, title, content, subject) VALUES (?, ?, ?, ?)`,
            [uid, title, content, bookmarks[0]?.subject || '']
        );

        res.json({
            ok: true,
            aiUsed,
            item: {
                id: result.lastID,
                title,
                content,
                subject: bookmarks[0]?.subject || '',
                created_at: new Date().toISOString(),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'SERVER_ERROR' });
    }
});

const SUBJECT_LABELS = {
    biology: '생명과학',
    physics: '물리학',
    chemistry: '화학',
    earth: '지구과학',
    geography: '지리학',
    '': '미분류',
};

function subjectLabel(subject) {
    return SUBJECT_LABELS[subject || ''] || subject || '미분류';
}

function lastDays(count) {
    const days = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}

function extractConcepts(messages) {
    const stopwords = new Set([
        '그리고',
        '그런데',
        '이거',
        '저거',
        '뭐야',
        '무엇',
        '설명',
        '알려줘',
        '해주세요',
        '문제',
        '퀴즈',
        '주제',
        '대한',
        '있는',
        '없는',
        '어떻게',
        '왜',
        'the',
        'and',
        'for',
        'with',
    ]);
    const counts = new Map();

    for (const message of messages) {
        const words = String(message || '')
            .toLowerCase()
            .replace(/[^\w가-힣\s]/g, ' ')
            .split(/\s+/)
            .map((word) =>
                word.replace(/(은|는|이|가|을|를|에|의|와|과|로|으로|도)$/g, '')
            )
            .filter((word) => word.length >= 2 && !stopwords.has(word));

        for (const word of words) {
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));
}

app.get('/api/teacher/dashboard', async (_req, res) => {
    try {
        const models = readJson(MODELS_JSON, []);
        const modelById = new Map(models.map((m) => [Number(m.id), m]));
        const knownSubjects = [
            ...new Set([
                'biology',
                'physics',
                'chemistry',
                'earth',
                'geography',
                ...models.map((m) => m.subject || ''),
            ]),
        ];

        const [bookmarkRows, noteRows, chatRows, questionTrendRows] =
            await Promise.all([
                dbAll(`SELECT model_id, created_at FROM bookmarks`),
                dbAll(`SELECT subject, title, content, created_at FROM notes`),
                dbAll(
                    `SELECT message, subject, with_quiz, created_at
                     FROM chat_logs
                     ORDER BY id DESC
                     LIMIT 300`
                ),
                dbAll(
                    `SELECT date(created_at) AS day, COUNT(*) AS count
                     FROM chat_logs
                     WHERE date(created_at) >= date('now', '-13 days')
                     GROUP BY date(created_at)
                     ORDER BY day`
                ),
            ]);

        const subjectStats = new Map(
            knownSubjects.map((subject) => [
                subject || '',
                {
                    subject: subject || '',
                    label: subjectLabel(subject),
                    models: 0,
                    bookmarks: 0,
                    questions: 0,
                    notes: 0,
                    engagement: 0,
                },
            ])
        );

        for (const model of models) {
            const key = model.subject || '';
            if (!subjectStats.has(key)) {
                subjectStats.set(key, {
                    subject: key,
                    label: subjectLabel(key),
                    models: 0,
                    bookmarks: 0,
                    questions: 0,
                    notes: 0,
                    engagement: 0,
                });
            }
            subjectStats.get(key).models += 1;
        }

        const bookmarkCounts = new Map();
        for (const row of bookmarkRows) {
            const model = modelById.get(Number(row.model_id));
            const subject = model?.subject || '';
            if (!subjectStats.has(subject)) {
                subjectStats.set(subject, {
                    subject,
                    label: subjectLabel(subject),
                    models: 0,
                    bookmarks: 0,
                    questions: 0,
                    notes: 0,
                    engagement: 0,
                });
            }
            subjectStats.get(subject).bookmarks += 1;
            bookmarkCounts.set(
                Number(row.model_id),
                (bookmarkCounts.get(Number(row.model_id)) || 0) + 1
            );
        }

        for (const row of noteRows) {
            const subject = row.subject || '';
            if (!subjectStats.has(subject)) {
                subjectStats.set(subject, {
                    subject,
                    label: subjectLabel(subject),
                    models: 0,
                    bookmarks: 0,
                    questions: 0,
                    notes: 0,
                    engagement: 0,
                });
            }
            subjectStats.get(subject).notes += 1;
        }

        for (const row of chatRows) {
            const subject = row.subject || '';
            if (!subjectStats.has(subject)) {
                subjectStats.set(subject, {
                    subject,
                    label: subjectLabel(subject),
                    models: 0,
                    bookmarks: 0,
                    questions: 0,
                    notes: 0,
                    engagement: 0,
                });
            }
            subjectStats.get(subject).questions += 1;
        }

        const units = [...subjectStats.values()]
            .map((item) => ({
                ...item,
                engagement:
                    item.questions * 4 + item.bookmarks * 3 + item.notes * 2,
            }))
            .sort((a, b) => b.engagement - a.engagement);

        const days = lastDays(14);
        const trendMap = new Map(
            questionTrendRows.map((row) => [row.day, Number(row.count)])
        );
        const questionTrend = days.map((day) => ({
            day,
            count: trendMap.get(day) || 0,
        }));

        const popularBookmarks = [...bookmarkCounts.entries()]
            .map(([id, count]) => {
                const model = modelById.get(Number(id));
                return {
                    id,
                    title: model?.title || `모델 #${id}`,
                    subject: model?.subject || '',
                    subjectLabel: subjectLabel(model?.subject || ''),
                    count,
                };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        const recentQuestions = chatRows.slice(0, 8).map((row) => ({
            message: row.message,
            subject: row.subject || '',
            subjectLabel: subjectLabel(row.subject || ''),
            withQuiz: Boolean(row.with_quiz),
            createdAt: row.created_at,
        }));

        res.json({
            ok: true,
            summary: {
                models: models.length,
                bookmarks: bookmarkRows.length,
                questions: chatRows.length,
                notes: noteRows.length,
            },
            questionTrend,
            conceptQuestions: extractConcepts(chatRows.map((row) => row.message)),
            unitFocus: units.slice(0, 8),
            popularBookmarks,
            recentQuestions,
        });
    } catch (e) {
        console.error('[teacher dashboard]', e);
        res.status(500).json({ error: 'TEACHER_DASHBOARD_FAILED' });
    }
});

/* ================== Admin: 모델 업로드/삭제/정렬 ================== */
// 업로드 (multipart/form-data: fields=title, description, url, subject, file=thumb)
app.post(
    '/api/models',
    requireAdmin,
    uploadThumb.single('thumb'),
    async (req, res) => {
        try {
            const { title, description, url, subject } = req.body || {};
            if (!title || !description || !url) {
                return res.status(400).json({ error: 'REQUIRED_FIELDS' });
            }

            const list = readJson(MODELS_JSON, []);
            const nextId =
                (list.reduce((m, cur) => Math.max(m, cur.id || 0), 0) || 0) + 1;

            const uploadedThumbPath = req.file
                ? `/uploads/thumbs/${req.file.filename}`
                : null;
            const thumb = await ensureAutoThumb({
                uploadedPath: uploadedThumbPath,
                title,
                description,
                key: title || String(nextId),
                modelUrl: url,
            });

            const item = {
                id: nextId,
                title,
                description,
                url,
                subject: subject || '',
                thumb,
            };
            list.unshift(item);
            writeJson(MODELS_JSON, list);
            res.json({ ok: true, item });
        } catch (e) {
            console.error('[POST /api/models]', e);
            res.status(500).json({ error: 'SERVER_ERROR' });
        }
    }
);

// 삭제
app.delete('/api/models/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const list = readJson(MODELS_JSON, []);
    const idx = list.findIndex((m) => Number(m.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'NOT_FOUND' });

    const [removed] = list.splice(idx, 1);
    writeJson(MODELS_JSON, list);

    if (removed?.thumb && removed.thumb.startsWith('/uploads/thumbs/')) {
        const abs = path.join(__dirname, removed.thumb.replace(/^\//, ''));
        fs.promises.unlink(abs).catch(() => {});
    }
    res.json({ ok: true });
});

// 순서 재정렬 (body: { order: [id,...] })
app.post('/api/models/reorder', requireAdmin, (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order) || !order.length) {
        return res.status(400).json({ error: 'INVALID_ORDER' });
    }
    const current = readJson(MODELS_JSON, []);
    const map = new Map(current.map((m) => [String(m.id), m]));
    const ordered = [];
    for (const id of order.map(String)) {
        if (map.has(id)) {
            ordered.push(map.get(id));
            map.delete(id);
        }
    }
    for (const rest of map.values()) ordered.push(rest);
    try {
        writeJson(MODELS_JSON, ordered);
        res.json({ ok: true, count: ordered.length });
    } catch (e) {
        console.error('[REORDER]', e);
        res.status(500).json({ error: 'SERVER_ERROR' });
    }
});

/* ================== 페이지 라우트 ================== */
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'intro.html'));
});
app.get('/mypage.html', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mypage.html'));
});
app.get(['/admin', '/admin/'], (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get(['/teacher', '/teacher/'], (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

/* ================== 서버 기동 ================== */
app.listen(PORT, () => {
    console.log(`Server → http://localhost:${PORT}`);
    if (!fs.existsSync(MODELS_JSON)) writeJson(MODELS_JSON, []);
    if (!fs.existsSync(CATEGORIES_JSON)) writeJson(CATEGORIES_JSON, []);
});
