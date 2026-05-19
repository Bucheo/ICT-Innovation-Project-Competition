/**
 * routes/aiNotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AI 노트 관련 API 라우터
 *
 *  POST /api/notes/generate          – AI 노트 즉시 생성 (캐시/Rate-limit 적용)
 *  POST /api/notes/generate/async    – 큐에 작업 등록 후 jobId 반환
 *  GET  /api/notes/jobs/:jobId       – 작업 상태 폴링
 *  POST /api/notes/:id/feedback      – 특정 노트의 AI 피드백 요청
 *  GET  /api/notes/stats             – 학습 통계 (대시보드)
 *  GET  /api/notes/feedback-history  – 최근 피드백 이력
 */

'use strict';

const express = require('express');
const router  = express.Router();

let _aiNoteService, _dbAll, _dbRun, _dbGet, _getUserId, _readJson, _MODELS_JSON;

/** index.js에서 의존성 주입 */
function injectDeps(deps) {
    _aiNoteService = deps.aiNoteService;
    _dbAll         = deps.dbAll;
    _dbRun         = deps.dbRun;
    _dbGet         = deps.dbGet;
    _getUserId     = deps.getUserId;
    _readJson      = deps.readJson;
    _MODELS_JSON   = deps.MODELS_JSON;
}

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

/** 선택된 modelId → 북마크/모델 정보 조회 */
async function resolveBookmarks(uid, selectedIds) {
    const placeholders = selectedIds.map(() => '?').join(',');
    const bookmarkRows = await _dbAll(
        `SELECT model_id, created_at FROM bookmarks
          WHERE user_id=? AND model_id IN (${placeholders})
          ORDER BY id DESC`,
        [uid, ...selectedIds]
    );
    if (!bookmarkRows.length) return [];

    const models = _readJson(_MODELS_JSON, []);
    return bookmarkRows
        .map(row => {
            const model = models.find(m => Number(m.id) === Number(row.model_id));
            if (!model) return null;
            return {
                id         : row.model_id,
                title      : model.title      || '',
                description: model.description|| '',
                subject    : model.subject     || '',
            };
        })
        .filter(Boolean);
}

/** 사용자의 관련 챗봇 대화 조회 */
async function resolveChat(uid, bookmarks) {
    const chatRows = await _dbAll(
        `SELECT message, subject, with_quiz, created_at
           FROM chat_logs WHERE user_id=? ORDER BY id DESC LIMIT 80`,
        [uid]
    );
    const selectedSubjects = new Set(bookmarks.map(b => b.subject).filter(Boolean));
    const keywords = [
        ...new Set(
            bookmarks.map(b => `${b.title} ${b.description}`).join(' ')
                .toLowerCase().replace(/[^\w가-힣\s]/g, ' ').split(/\s+/)
                .filter(w => w.length >= 2)
        ),
    ].slice(0, 24);

    return chatRows.filter(row => {
        const msg = String(row.message || '').toLowerCase();
        return (row.subject && selectedSubjects.has(row.subject))
            || keywords.some(k => msg.includes(k));
    }).slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notes/generate  (즉시 생성 – 기존 엔드포인트 대체)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const selectedIds = [...new Set(
            ((req.body || {}).modelIds || [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        )];
        if (!selectedIds.length) return res.status(400).json({ error: 'BOOKMARK_SELECTION_REQUIRED' });

        const bookmarks = await resolveBookmarks(uid, selectedIds);
        if (!bookmarks.length) return res.status(400).json({ error: 'SELECTED_BOOKMARK_NOT_FOUND' });

        const chatRows = await resolveChat(uid, bookmarks);

        const { title, content, subject, aiUsed, fromCache } = await _aiNoteService.generateNote(
            uid, selectedIds, bookmarks, chatRows
        );

        const result = await _dbRun(
            `INSERT INTO notes (user_id, title, content, subject) VALUES (?, ?, ?, ?)`,
            [uid, title, content, subject]
        );

        // 캐시 무효화 (방금 생성했으므로 다음 요청은 최신 DB에서)
        _aiNoteService.noteCache.invalidateUser(uid);

        res.json({
            ok     : true,
            aiUsed,
            fromCache: fromCache || false,
            item   : {
                id        : result.lastID,
                title,
                content,
                subject,
                created_at: new Date().toISOString(),
            },
        });
    } catch (err) {
        if (err.message === 'RATE_LIMIT') {
            return res.status(429).json({
                error     : 'RATE_LIMIT_EXCEEDED',
                message   : `요청이 너무 많습니다. ${err.retryAfter}초 후 다시 시도하세요.`,
                retryAfter: err.retryAfter,
            });
        }
        console.error('[/notes/generate]', err.message);
        res.status(500).json({ error: err.message || 'SERVER_ERROR' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notes/generate/async  (비동기 큐 – 대용량 요청 시 사용)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate/async', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const selectedIds = [...new Set(
            ((req.body || {}).modelIds || [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        )];
        if (!selectedIds.length) return res.status(400).json({ error: 'BOOKMARK_SELECTION_REQUIRED' });

        const jobId = await _aiNoteService.enqueueJob(uid, selectedIds);
        res.json({ ok: true, jobId, message: '작업이 큐에 등록되었습니다. /api/notes/jobs/:jobId 로 상태를 확인하세요.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notes/jobs/:jobId  (작업 상태 폴링)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs/:jobId', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const job = await _aiNoteService.getJobStatus(Number(req.params.jobId), uid);
        if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND' });

        const resp = { ok: true, job };

        // 완료 시 노트 내용도 함께 반환
        if (job.status === 'done' && job.result_note_id) {
            const note = await _dbGet(`SELECT * FROM notes WHERE id=?`, [job.result_note_id]);
            resp.note = note;
        }
        res.json(resp);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notes/stats  (학습 통계)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });
        const stats = await _aiNoteService.getNoteStats(uid);
        res.json({ ok: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notes/feedback-history  (최근 피드백 이력)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/feedback-history', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const rows = await _dbAll(
            `SELECT f.id, f.score, f.feedback, f.strengths, f.improvements, f.created_at,
                    n.id as note_id, n.title as note_title
               FROM note_feedbacks f
               JOIN notes n ON n.id = f.note_id
              WHERE n.user_id=?
              ORDER BY f.created_at DESC
              LIMIT 20`,
            [uid]
        );
        res.json({
            ok   : true,
            items: rows.map(r => ({
                ...r,
                strengths   : JSON.parse(r.strengths    || '[]'),
                improvements: JSON.parse(r.improvements || '[]'),
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notes/:id/feedback  (노트 피드백 생성)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/feedback', async (req, res) => {
    try {
        const uid = await _getUserId(req.me.username);
        if (!uid) return res.status(401).json({ error: 'UNAUTHORIZED' });

        const noteId = Number(req.params.id);
        if (!noteId) return res.status(400).json({ error: 'INVALID_NOTE_ID' });

        const result = await _aiNoteService.generateFeedback(uid, noteId);
        res.json({ ok: true, ...result });
    } catch (err) {
        if (err.message === 'NOTE_NOT_FOUND') return res.status(404).json({ error: 'NOTE_NOT_FOUND' });
        if (err.message === 'RATE_LIMIT') {
            return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED', retryAfter: err.retryAfter });
        }
        console.error('[/notes/:id/feedback]', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, injectDeps };
