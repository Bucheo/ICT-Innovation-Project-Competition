/**
 * aiNoteService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 나만의 AI 노트 서비스 – 대규모 트래픽 대응 설계
 *
 * 주요 기능:
 *  1. 인메모리 LRU 캐시       – 동일 요청 반복 시 AI 호출 없이 즉시 응답
 *  2. 요청 큐(Job Queue)      – DB에 작업 저장 후 순차 처리, 서버 재시작 시 복구
 *  3. Rate Limiter             – 사용자별 분당 요청 수 제한 (스팸/과부하 방지)
 *  4. 동시성 제어 (Semaphore)  – AI 서버 동시 호출 수 제한
 *  5. Circuit Breaker          – AI 서버 장애 시 자동 fallback
 *  6. 피드백 생성              – 저장된 노트를 분석하여 학습 피드백 제공
 */

'use strict';

const axios = require('axios');

// ── 설정 상수 ─────────────────────────────────────────────────────────────────
const PYTHON_AI_SERVER  = process.env.AI_SERVER || 'http://127.0.0.1:8000';
const AI_TIMEOUT_MS     = 120_000;
const CACHE_TTL_MS      = 10 * 60 * 1000;   // 10분
const CACHE_MAX_SIZE    = 200;               // LRU 최대 항목
const RATE_LIMIT_PER_MIN = 5;               // 사용자당 분당 최대 AI 노트 생성
const MAX_CONCURRENT_AI = 3;                // AI 동시 호출 최대 수
const CIRCUIT_BREAK_THRESHOLD = 5;          // 연속 실패 N회 시 차단
const CIRCUIT_RESET_MS  = 60_000;           // 1분 후 재시도

// ── 의존 주입용 DB 함수 (index.js에서 주입) ───────────────────────────────────
let _dbAll, _dbRun, _dbGet;
function injectDb(dbAll, dbRun, dbGet) {
    _dbAll = dbAll;
    _dbRun = dbRun;
    _dbGet = dbGet;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LRU 캐시 (Map의 삽입 순서를 이용한 간단한 LRU)
// ─────────────────────────────────────────────────────────────────────────────
class LRUCache {
    constructor(maxSize, ttlMs) {
        this.maxSize = maxSize;
        this.ttlMs   = ttlMs;
        this.map     = new Map();
    }
    _key(userId, modelIds) {
        return `${userId}:${[...modelIds].sort().join(',')}`;
    }
    get(userId, modelIds) {
        const key  = this._key(userId, modelIds);
        const item = this.map.get(key);
        if (!item) return null;
        if (Date.now() - item.ts > this.ttlMs) { this.map.delete(key); return null; }
        // 최신 사용 → 뒤로 이동 (LRU 갱신)
        this.map.delete(key);
        this.map.set(key, item);
        return item.value;
    }
    set(userId, modelIds, value) {
        const key = this._key(userId, modelIds);
        if (this.map.has(key)) this.map.delete(key);
        if (this.map.size >= this.maxSize) {
            // 가장 오래된 항목 제거
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, { value, ts: Date.now() });
    }
    invalidateUser(userId) {
        for (const key of this.map.keys()) {
            if (key.startsWith(`${userId}:`)) this.map.delete(key);
        }
    }
    stats() {
        return { size: this.map.size, maxSize: this.maxSize };
    }
}

const noteCache = new LRUCache(CACHE_MAX_SIZE, CACHE_TTL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Rate Limiter (슬라이딩 윈도우)
// ─────────────────────────────────────────────────────────────────────────────
class RateLimiter {
    constructor(maxPerMin) {
        this.max    = maxPerMin;
        this.window = 60_000;
        this.map    = new Map(); // userId → timestamps[]
    }
    check(userId) {
        const now  = Date.now();
        const hits = (this.map.get(userId) || []).filter(t => now - t < this.window);
        if (hits.length >= this.max) {
            const retry = Math.ceil((this.window - (now - hits[0])) / 1000);
            return { allowed: false, retryAfter: retry };
        }
        hits.push(now);
        this.map.set(userId, hits);
        return { allowed: true };
    }
    // 메모리 누수 방지: 1분마다 오래된 항목 정리
    _cleanup() {
        const now = Date.now();
        for (const [uid, hits] of this.map) {
            const fresh = hits.filter(t => now - t < this.window);
            if (!fresh.length) this.map.delete(uid);
            else this.map.set(uid, fresh);
        }
    }
}
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MIN);
setInterval(() => rateLimiter._cleanup(), 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Semaphore (동시 AI 호출 제한)
// ─────────────────────────────────────────────────────────────────────────────
class Semaphore {
    constructor(max) {
        this.max     = max;
        this.current = 0;
        this.queue   = [];
    }
    acquire() {
        return new Promise(resolve => {
            if (this.current < this.max) { this.current++; resolve(); }
            else this.queue.push(resolve);
        });
    }
    release() {
        this.current--;
        if (this.queue.length) { this.current++; this.queue.shift()(); }
    }
    get waiting() { return this.queue.length; }
}
const aiSemaphore = new Semaphore(MAX_CONCURRENT_AI);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Circuit Breaker (AI 서버 장애 자동 감지)
// ─────────────────────────────────────────────────────────────────────────────
const circuit = {
    failures : 0,
    openedAt : 0,
    isOpen() {
        if (this.failures < CIRCUIT_BREAK_THRESHOLD) return false;
        if (Date.now() - this.openedAt > CIRCUIT_RESET_MS) {
            console.log('[Circuit] Half-open: AI 서버 재시도');
            this.failures = 0;
            return false;
        }
        return true;
    },
    onSuccess() { this.failures = 0; },
    onFailure() {
        this.failures++;
        if (this.failures === CIRCUIT_BREAK_THRESHOLD) {
            this.openedAt = Date.now();
            console.warn(`[Circuit] OPEN: AI 서버 ${CIRCUIT_BREAK_THRESHOLD}회 연속 실패`);
        }
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. AI 서버 호출 (Semaphore + Circuit Breaker 적용)
// ─────────────────────────────────────────────────────────────────────────────
async function callAI(prompt) {
    if (circuit.isOpen()) throw new Error('AI_CIRCUIT_OPEN');
    await aiSemaphore.acquire();
    try {
        const resp = await axios.post(
            `${PYTHON_AI_SERVER}/chat`,
            { message: prompt, subject: '', with_quiz: false },
            { timeout: AI_TIMEOUT_MS }
        );
        circuit.onSuccess();
        return resp.data?.answer || null;
    } catch (err) {
        circuit.onFailure();
        throw err;
    } finally {
        aiSemaphore.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. fallback 노트 생성 (AI 없이 구조화된 텍스트 반환)
// ─────────────────────────────────────────────────────────────────────────────
function buildFallbackNote(bookmarks, chatRows) {
    const lines = [
        '# 📚 핵심 개념',
        bookmarks.length
            ? bookmarks.map(m => `- **${m.title}**: ${m.description || '북마크한 개념'}`).join('\n')
            : '- 아직 북마크한 개념이 없습니다.',
        '',
        '# 💬 질문으로 보강한 내용',
        chatRows.length
            ? chatRows.map(r => `- ${r.message}`).join('\n')
            : '- 관련 챗봇 질문 기록이 없습니다.',
        '',
        '# 🔄 다시 확인할 개념',
        chatRows.some(r => r.with_quiz)
            ? chatRows.filter(r => r.with_quiz).map(r => `- 퀴즈 요청: ${r.message}`).join('\n')
            : '- 퀴즈 요청 기록이 생기면 여기에 표시됩니다.',
        '',
        '# ✏️ 직접 보완할 부분',
        '- 이 부분에 스스로 정리한 내용을 추가해보세요.',
    ];
    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 챗봇 질문 패턴 분석 (약점/관심사 추출)
// ─────────────────────────────────────────────────────────────────────────────

const SUBJECT_KO = {
    biology  : '생명과학', physics  : '물리학',
    chemistry: '화학',     earth    : '지구과학',
    geography: '지리학',
};

/**
 * 챗봇 질문 목록을 분석해 학습 패턴을 추출한다.
 *  - 과목별 질문 빈도 → 관심 과목 파악
 *  - 퀴즈 요청 여부  → 자신감 없는 개념 파악
 *  - 반복 키워드     → 자주 헷갈리는 개념 파악
 *  - 질문 총 수      → 학습 적극성 파악
 */
function analyzeChatPattern(chatRows) {
    // 1) 과목별 빈도
    const subjectCount = {};
    for (const r of chatRows) {
        const s = r.subject || 'general';
        subjectCount[s] = (subjectCount[s] || 0) + 1;
    }
    const topSubjects = Object.entries(subjectCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, cnt]) => `${SUBJECT_KO[s] || s}(${cnt}회)`);

    // 2) 퀴즈 요청 → 자신감 부족 개념
    const quizMsgs = chatRows.filter(r => r.with_quiz).map(r => r.message);

    // 3) 반복 키워드 추출 (2글자 이상 한글 단어, 불용어 제외)
    const STOPWORDS = new Set(['이란','이란','무엇','무엇인','어떻게','왜','설명','알려','해줘','해주세요','대해','에서','에는','이다','이고','하는','하면','있는','있어','있나요','있을','나요','이유','방법','차이','관계','종류','특징','예시','원리','공식','정의','개념','의미','뭔가요','뭐야','가요']);
    const wordFreq = {};
    for (const r of chatRows) {
        const words = (r.message || '').match(/[가-힣]{2,6}/g) || [];
        for (const w of words) {
            if (!STOPWORDS.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
        }
    }
    const repeatedKeywords = Object.entries(wordFreq)
        .filter(([, cnt]) => cnt >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w, cnt]) => `"${w}"(${cnt}회 언급)`);

    // 4) 최근 질문 (최신 5개, 맥락용)
    const recentQuestions = chatRows.slice(0, 5).map(r => r.message);

    // 5) 답변을 못 받은 것 같은 질문(퀴즈 & 반복 언급) = 약점 후보
    const weaknessCandidates = chatRows
        .filter(r => r.with_quiz || (wordFreq[((r.message||'').match(/[가-힣]{2,6}/g)||[])[0]] >= 2))
        .slice(0, 4)
        .map(r => r.message);

    return {
        topSubjects,
        quizMsgs,
        repeatedKeywords,
        recentQuestions,
        weaknessCandidates,
        totalQuestions: chatRows.length,
    };
}

/**
 * 노트 내용 자체도 분석해 학습 깊이를 수치화한다.
 *  - 섹션 수, 글자 수, 키워드 밀도 등
 */
function analyzeNoteDepth(note) {
    const content = note.content || '';
    const lines    = content.split('\n').filter(l => l.trim());
    const sections = (content.match(/^#+\s/gm) || []).length;
    const bullets  = (content.match(/^[\-\*]\s/gm) || []).length;
    const charLen  = content.length;
    const sentences = (content.match(/[.!?。]\s|\n/g) || []).length + 1;
    const hasExamples = /예시|예를 들|예를들|예:/.test(content);
    const hasFormula  = /공식|식:|\$/.test(content);
    const hasSummary  = /요약|정리|핵심/.test(content);
    const hasDefinition = /이란|이다\.|란\s|정의|개념/.test(content);
    const hasConnection = /따라서|그러므로|왜냐하면|때문에|관계|연결/.test(content);

    // 노트 품질 등급 (AI에게 명확하게 전달)
    let grade, gradeReason;
    if (charLen < 20) {
        grade = 'F';
        gradeReason = `노트 내용이 거의 없음 (${charLen}자). 제목/단어 수준에 불과함`;
    } else if (charLen < 80) {
        grade = 'D';
        gradeReason = `노트 내용이 매우 부족 (${charLen}자). 한 두 문장 수준`;
    } else if (charLen < 200) {
        grade = 'C';
        gradeReason = `기초적인 내용만 있음 (${charLen}자). 구체적 설명 부족`;
    } else if (charLen < 500) {
        grade = 'B';
        gradeReason = `보통 수준 (${charLen}자). 내용이 있으나 심화 필요`;
    } else {
        grade = 'A';
        gradeReason = `충분한 분량 (${charLen}자). 구체적 내용 포함`;
    }

    // 점수 상한: 내용이 부족하면 아무리 잘해도 높은 점수 불가
    const maxScore = { F: 15, D: 30, C: 50, B: 75, A: 100 }[grade];

    return {
        lines: lines.length, sections, bullets, charLen, sentences,
        hasExamples, hasFormula, hasSummary, hasDefinition, hasConnection,
        grade, gradeReason, maxScore,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7-B. AI 피드백 생성 프롬프트 빌더 (심층 분석 버전)
// ─────────────────────────────────────────────────────────────────────────────
function buildFeedbackPrompt(note, chatRows, allNotes) {
    const chat    = analyzeChatPattern(chatRows);
    const depth   = analyzeNoteDepth(note);

    // 사용자 전체 노트 제목 목록 (학습 범위 파악용)
    const noteHistory = (allNotes || [])
        .filter(n => n.id !== note.id)
        .map(n => n.title)
        .slice(0, 10);

    const lines = [
        '당신은 중고등학생의 학습을 분석하는 엄격한 AI 튜터입니다.',
        '아래 데이터를 종합해 학생의 ① 약한 부분, ② 관심 분야, ③ 학습 습관을 파악하고',
        '구체적이고 개인화된 피드백을 한국어로 작성하세요.',
        '',
        '⚠️ 절대 규칙 (반드시 준수):',
        '1. 순수 JSON만 출력. 마크다운 코드블록, 설명 텍스트 일절 금지.',
        `2. score는 반드시 ${depth.maxScore} 이하로 설정. (노트 등급: ${depth.grade} — ${depth.gradeReason})`,
        '3. 노트 내용이 한 문장 이하이면 score는 절대 20을 넘기면 안 됨.',
        '4. strengths는 노트 내용을 그대로 반복 금지. 실제 잘한 근거를 서술.',
        '5. 내용이 부족하면 strengths에 "노트 작성 자체" 같은 막연한 칭찬 금지.',
        '6. improvements는 "더 작성하세요" 수준이 아닌 구체적 행동 지침으로.',
        '7. feedback은 노트 내용 + 챗봇 질문 패턴을 모두 반영해 개인화.',
        '',
        '=== 출력 형식 ===',
        '{',
        `  "score": <0~${depth.maxScore} 사이 정수, 이 범위를 절대 초과 불가>,`,
        '  "feedback": "<노트 분량/질 + 챗봇 패턴 기반 개인화 피드백 3문장>",',
        '  "weak_areas": ["약한 개념1", "약한 개념2"],',
        '  "interest_areas": ["관심 분야1", "관심 분야2"],',
        '  "strengths": ["실제 잘된 점1(근거 포함)", "실제 잘된 점2(근거 포함)"],',
        '  "improvements": ["지금 당장 할 수 있는 구체적 개선 행동1", "개선 행동2"]',
        '}',
        '',
        '=== 분석 데이터 ===',
        '',
        `[노트 제목] ${note.title}`,
        `[노트 내용 (${depth.charLen}자)] — 등급: ${depth.grade} (${depth.gradeReason})`,
        `${note.content || '(내용 없음)'}`,
        '',
        '[노트 구조 지표]',
        `- 글자 수: ${depth.charLen}자 / 문장 수: ${depth.sentences}개 / 줄: ${depth.lines}줄`,
        `- 섹션헤더: ${depth.sections}개 / 불릿: ${depth.bullets}개`,
        `- 예시: ${depth.hasExamples ? '있음' : '없음'} / 정의: ${depth.hasDefinition ? '있음' : '없음'} / 연결어: ${depth.hasConnection ? '있음' : '없음'} / 요약: ${depth.hasSummary ? '있음' : '없음'}`,
        '',
        `[챗봇 질문 분석] (총 ${chat.totalQuestions}회 질문)`,
        chat.topSubjects.length
            ? `- 주요 관심 과목: ${chat.topSubjects.join(', ')}`
            : '- 과목별 질문 기록 없음',
        chat.repeatedKeywords.length
            ? `- 반복 언급 키워드(헷갈리는 개념 후보): ${chat.repeatedKeywords.join(', ')}`
            : '- 반복 키워드 없음',
        chat.quizMsgs.length
            ? `- 퀴즈 요청(자신감 부족 개념): ${chat.quizMsgs.slice(0,3).map(m=>`"${m}"`).join(' / ')}`
            : '- 퀴즈 요청 없음',
        chat.weaknessCandidates.length
            ? `- 약점 후보 질문: ${chat.weaknessCandidates.map(m=>`"${m}"`).join(' / ')}`
            : '',
        '',
        chat.recentQuestions.length
            ? `[최근 질문 5개]\n${chat.recentQuestions.map((q,i)=>`${i+1}. ${q}`).join('\n')}`
            : '[챗봇 질문 기록 없음 - 노트 내용만으로 분석]',
        '',
        noteHistory.length
            ? `[이전 학습 노트 제목] (학습 범위 파악용)\n${noteHistory.map((t,i)=>`${i+1}. ${t}`).join('\n')}`
            : '',
    ];

    return lines.filter(l => l !== undefined).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. AI 노트 생성 프롬프트 빌더
// ─────────────────────────────────────────────────────────────────────────────
function buildNotePrompt(bookmarks, chatRows) {
    return [
        '사용자의 개인 학습 노트를 한국어로 작성해 주세요.',
        '사용자가 선택한 3D 학습 개념을 중심으로 정리하고, 챗봇 대화는 관련 질문만 참고합니다.',
        '아래 섹션을 포함하세요: 핵심 개념, 질문으로 보강한 내용, 다시 확인할 개념, 직접 보완할 부분.',
        'Bullet 위주, 2000자 이내로 간결하게 작성하세요.',
        '',
        `선택한 북마크 (${bookmarks.length}개):\n${JSON.stringify(bookmarks, null, 2)}`,
        '',
        chatRows.length
            ? `관련 챗봇 질문 (${chatRows.length}개):\n${JSON.stringify(chatRows.map(r => ({ message: r.message, subject: r.subject, withQuiz: !!r.with_quiz })), null, 2)}`
            : '',
    ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 노트 생성 (캐시 → 큐 → AI → fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function generateNote(userId, selectedModelIds, bookmarks, chatRows) {
    // 캐시 확인
    const cached = noteCache.get(userId, selectedModelIds);
    if (cached) {
        console.log(`[NoteService] 캐시 HIT (user=${userId})`);
        return { ...cached, fromCache: true };
    }

    // Rate Limit
    const rl = rateLimiter.check(userId);
    if (!rl.allowed) {
        throw Object.assign(new Error('RATE_LIMIT'), { retryAfter: rl.retryAfter });
    }

    const titleBase = bookmarks.length === 1
        ? bookmarks[0].title
        : `${bookmarks[0].title} 외 ${bookmarks.length - 1}개`;
    const title = `AI 학습 노트 - ${titleBase}`;

    let content = buildFallbackNote(bookmarks, chatRows);
    let aiUsed  = false;

    if (bookmarks.length || chatRows.length) {
        try {
            const prompt = buildNotePrompt(bookmarks, chatRows);
            const answer = await callAI(prompt);
            if (answer) { content = answer.trim(); aiUsed = true; }
        } catch (err) {
            if (err.message !== 'AI_CIRCUIT_OPEN') {
                console.warn('[NoteService] AI fallback:', err.message);
            }
        }
    }

    const subject = bookmarks[0]?.subject || '';
    const result  = { title, content, subject, aiUsed };

    // 캐시 저장
    noteCache.set(userId, selectedModelIds, result);
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. 피드백 생성 (노트 + 챗봇 대화 기반)
// ─────────────────────────────────────────────────────────────────────────────
async function generateFeedback(userId, noteId) {
    const note = await _dbGet(`SELECT * FROM notes WHERE id=? AND user_id=?`, [noteId, userId]);
    if (!note) throw Object.assign(new Error('NOTE_NOT_FOUND'), { status: 404 });

    // 기존 피드백이 1시간 이내라면 재사용
    const existing = await _dbGet(
        `SELECT * FROM note_feedbacks WHERE note_id=? ORDER BY created_at DESC LIMIT 1`,
        [noteId]
    );
    if (existing) {
        const age = Date.now() - new Date(existing.created_at).getTime();
        if (age < 60 * 60 * 1000) {
            return {
                feedback     : existing.feedback,
                strengths    : JSON.parse(existing.strengths    || '[]'),
                improvements : JSON.parse(existing.improvements || '[]'),
                weakAreas    : JSON.parse(existing.weak_areas   || '[]'),
                interestAreas: JSON.parse(existing.interest_areas || '[]'),
                score        : existing.score,
                fromCache    : true,
            };
        }
    }

    // ── 분석에 필요한 데이터 병렬 조회 ──────────────────────────────────────
    const [chatRows, allNotes] = await Promise.all([
        // 전체 챗봇 질문 (과목·퀴즈여부 포함, 최대 60개)
        _dbAll(
            `SELECT message, subject, with_quiz, created_at
               FROM chat_logs
              WHERE user_id=?
              ORDER BY id DESC
              LIMIT 60`,
            [userId]
        ),
        // 사용자의 다른 노트 제목 (학습 범위 파악)
        _dbAll(
            `SELECT id, title, subject FROM notes WHERE user_id=? ORDER BY created_at DESC LIMIT 15`,
            [userId]
        ),
    ]);

    // ── AI 호출 ───────────────────────────────────────────────────────────────
    let parsed = null;
    try {
        const prompt = buildFeedbackPrompt(note, chatRows, allNotes);
        const answer = await callAI(prompt);
        if (answer) {
            const clean = answer.replace(/```json[\s\S]*?```|```/g, '').trim();
            // JSON 블록만 추출 (앞뒤 텍스트 무시)
            const jsonMatch = clean.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.warn('[NoteService] Feedback AI error:', err.message);
    }

    // ── fallback: 로컬 분석으로 기본 피드백 생성 ─────────────────────────────
    if (!parsed) {
        const chat  = analyzeChatPattern(chatRows);
        const depth = analyzeNoteDepth(note);

        const weakAreas = [
            ...chat.quizMsgs.slice(0, 2).map(m => {
                const kw = (m.match(/[가-힣]{2,6}/g) || []).slice(0, 2).join(' ');
                return kw ? `${kw} 개념 복습 필요` : null;
            }),
            ...chat.weaknessCandidates.slice(0, 1).map(m => {
                const kw = (m.match(/[가-힣]{2,6}/g) || []).slice(0, 2).join(' ');
                return kw ? `${kw} 이해 보충 필요` : null;
            }),
        ].filter(Boolean).slice(0, 3);

        const interestAreas = chat.topSubjects.length
            ? chat.topSubjects.map(s => s.replace(/\(\d+회\)/, '').trim())
            : ['학습 기록 누적 중'];

        // 등급 기반 점수: 최대 점수(maxScore) 안에서 세부 요소 반영
        const baseScore = {F: 5, D: 15, C: 30, B: 55, A: 70}[depth.grade];
        const bonusScore = (depth.sections > 0 ? 3 : 0)
            + (depth.bullets > 2 ? 3 : 0)
            + (depth.hasExamples ? 5 : 0)
            + (depth.hasDefinition ? 3 : 0)
            + (depth.hasConnection ? 3 : 0)
            + (depth.hasSummary ? 3 : 0);
        const calcScore = Math.min(depth.maxScore, baseScore + bonusScore);

        // 등급별 strengths/improvements 메시지
        const gradeMessages = {
            F: {
                strengths   : ['주제를 정하고 노트를 시작한 점은 좋습니다.'],
                improvements: [
                    `"${note.title}"의 정의를 3줄 이상으로 직접 작성해보세요.`,
                    '챗봇에 "○○이란 무엇인가요?"라고 질문해서 내용을 채워보세요.',
                ],
            },
            D: {
                strengths   : ['주제를 정하고 기본 내용을 작성했습니다.'],
                improvements: [
                    '현재 내용에 구체적인 예시를 1개 이상 추가해보세요.',
                    '관련 개념을 2~3개 더 찾아서 연결해보세요.',
                ],
            },
            C: {
                strengths   : [
                    '기본 개념을 파악하고 노트에 담았습니다.',
                    depth.hasDefinition ? '개념의 정의를 포함했습니다.' : '주제와 관련된 내용을 정리했습니다.',
                ],
                improvements: [
                    depth.hasExamples ? '예시를 더 다양하게 추가해보세요.' : '각 개념마다 실생활 예시를 추가해보세요.',
                    '개념들 간의 연관성을 화살표나 글로 정리해보세요.',
                ],
            },
            B: {
                strengths   : [
                    '충분한 분량으로 개념을 정리했습니다.',
                    depth.hasExamples ? '예시를 활용해 이해를 높였습니다.' : '핵심 내용을 구조적으로 정리했습니다.',
                ],
                improvements: [
                    !depth.hasSummary ? '마지막에 핵심 내용을 3줄로 요약해보세요.' : '다른 단원 개념과 연결지어 정리해보세요.',
                    chat.totalQuestions < 5 ? '챗봇으로 모르는 부분을 더 질문해보세요.' : '틀리기 쉬운 개념을 별도로 표시해보세요.',
                ],
            },
            A: {
                strengths   : [
                    '풍부한 내용으로 심화 학습을 했습니다.',
                    depth.hasExamples && depth.hasSummary ? '예시와 요약을 모두 포함한 완성도 높은 노트입니다.' : '체계적으로 개념을 정리했습니다.',
                ],
                improvements: [
                    '다른 과목 개념과 융합적으로 연결해보세요.',
                    '이 노트를 보고 퀴즈를 직접 만들어보면 기억에 더 오래 남습니다.',
                ],
            },
        };

        const gMsg = gradeMessages[depth.grade];

        parsed = {
            score        : calcScore,
            feedback     : `노트 분량이 ${depth.charLen}자(${depth.grade}등급)로 ${
                {F:'거의 비어 있습니다. 지금 바로 내용을 채워야 합니다.',
                 D:'매우 부족합니다. 구체적인 설명을 추가해야 합니다.',
                 C:'기초 수준입니다. 예시와 설명을 보강하면 좋겠습니다.',
                 B:'보통 수준입니다. 심화 내용을 추가하면 더 좋아집니다.',
                 A:'충분합니다. 다른 개념과 연결하는 심화 학습을 해보세요.'}[depth.grade]
            } ` +
            (chat.totalQuestions > 0
                ? `챗봇 질문 ${chat.totalQuestions}회 중 ` +
                  (chat.topSubjects.length ? `${chat.topSubjects[0].replace(/\(\d+회\)/,'').trim()} 분야 관심이 두드러집니다. ` : '') +
                  (weakAreas.length ? `"${weakAreas[0]}" 개념 보완이 필요합니다.` : '다양한 개념을 균형 있게 학습하고 있습니다.')
                : '챗봇 질문 기록이 없습니다. 모르는 개념을 챗봇에 질문해보세요.'),
            weak_areas    : weakAreas.length ? weakAreas : ['아직 약점 데이터가 부족합니다. 챗봇에 더 질문해보세요.'],
            interest_areas: interestAreas,
            strengths     : gMsg.strengths,
            improvements  : gMsg.improvements,
        };
    }

    // ── DB 저장 (weak_areas, interest_areas 컬럼 추가 저장) ─────────────────
    // note_feedbacks 테이블에 weak_areas, interest_areas 컬럼이 없을 수 있으니
    // 안전하게 ALTER TABLE 후 저장
    try {
        await _dbRun(`ALTER TABLE note_feedbacks ADD COLUMN weak_areas TEXT DEFAULT '[]'`);
    } catch (_) { /* 이미 있으면 무시 */ }
    try {
        await _dbRun(`ALTER TABLE note_feedbacks ADD COLUMN interest_areas TEXT DEFAULT '[]'`);
    } catch (_) { /* 이미 있으면 무시 */ }

    // analyzeNoteDepth의 maxScore로 AI 응답 점수 상한 강제 적용
    const depth2   = analyzeNoteDepth(note);
    const rawScore = parseInt(parsed.score) || 50;
    const score    = Math.min(depth2.maxScore, Math.max(0, rawScore));
    await _dbRun(
        `INSERT INTO note_feedbacks
           (note_id, user_id, feedback, strengths, improvements, score, weak_areas, interest_areas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            noteId, userId,
            parsed.feedback,
            JSON.stringify(parsed.strengths     || []),
            JSON.stringify(parsed.improvements  || []),
            score,
            JSON.stringify(parsed.weak_areas    || []),
            JSON.stringify(parsed.interest_areas|| []),
        ]
    );

    return {
        feedback     : parsed.feedback,
        strengths    : parsed.strengths      || [],
        improvements : parsed.improvements   || [],
        weakAreas    : parsed.weak_areas     || [],
        interestAreas: parsed.interest_areas || [],
        score,
        fromCache    : false,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Job Queue (DB 기반, 서버 재시작 시 복구)
// ─────────────────────────────────────────────────────────────────────────────
let jobWorkerRunning = false;

async function enqueueJob(userId, modelIds) {
    const result = await _dbRun(
        `INSERT INTO note_generation_jobs (user_id, model_ids, status) VALUES (?, ?, 'pending')`,
        [userId, JSON.stringify(modelIds)]
    );
    triggerWorker();
    return result.lastID;
}

async function getJobStatus(jobId, userId) {
    return _dbGet(
        `SELECT id, status, result_note_id, error_msg, ai_used, created_at, updated_at
           FROM note_generation_jobs WHERE id=? AND user_id=?`,
        [jobId, userId]
    );
}

function triggerWorker() {
    if (!jobWorkerRunning) processNextJob();
}

async function processNextJob() {
    jobWorkerRunning = true;
    try {
        const job = await _dbGet(
            `SELECT * FROM note_generation_jobs
              WHERE status='pending'
              ORDER BY priority ASC, created_at ASC
              LIMIT 1`
        );
        if (!job) { jobWorkerRunning = false; return; }

        await _dbRun(
            `UPDATE note_generation_jobs SET status='processing', updated_at=datetime('now','localtime') WHERE id=?`,
            [job.id]
        );

        try {
            const modelIds  = JSON.parse(job.model_ids || '[]');
            // 모델 정보와 북마크 조회 (index.js의 readJson 대신 DB에서)
            const bookmarkQ = modelIds.map(() => '?').join(',');
            const bRows     = await _dbAll(
                `SELECT bm.model_id FROM bookmarks bm WHERE bm.user_id=? AND bm.model_id IN (${bookmarkQ})`,
                [job.user_id, ...modelIds]
            );
            // fallback 북마크
            const bookmarks = bRows.map(r => ({ title: `개념 #${r.model_id}`, description: '', subject: '' }));
            const chatRows  = await _dbAll(
                `SELECT message, subject, with_quiz FROM chat_logs WHERE user_id=? ORDER BY id DESC LIMIT 80`,
                [job.user_id]
            );

            const { title, content, subject, aiUsed } = await generateNote(job.user_id, modelIds, bookmarks, chatRows);
            const ins = await _dbRun(
                `INSERT INTO notes (user_id, title, content, subject) VALUES (?, ?, ?, ?)`,
                [job.user_id, title, content, subject]
            );
            await _dbRun(
                `UPDATE note_generation_jobs
                    SET status='done', result_note_id=?, ai_used=?, updated_at=datetime('now','localtime')
                  WHERE id=?`,
                [ins.lastID, aiUsed ? 1 : 0, job.id]
            );
        } catch (err) {
            await _dbRun(
                `UPDATE note_generation_jobs
                    SET status='failed', error_msg=?, updated_at=datetime('now','localtime')
                  WHERE id=?`,
                [err.message, job.id]
            );
        }
    } catch (err) {
        console.error('[JobWorker]', err.message);
    }

    // 다음 작업 처리 (0ms 딜레이로 이벤트 루프 양보)
    setImmediate(processNextJob);
}

// 서버 시작 시 pending 작업 복구
async function recoverPendingJobs() {
    try {
        // processing 상태로 멈춘 작업 복구
        await _dbRun(
            `UPDATE note_generation_jobs SET status='pending' WHERE status='processing'`
        );
        const pending = await _dbAll(`SELECT COUNT(*) as cnt FROM note_generation_jobs WHERE status='pending'`);
        if (pending[0]?.cnt > 0) {
            console.log(`[JobWorker] ${pending[0].cnt}개 미완료 작업 복구`);
            triggerWorker();
        }
    } catch (err) {
        console.warn('[JobWorker] 복구 실패:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. 노트 통계 (사용자 학습 대시보드용)
// ─────────────────────────────────────────────────────────────────────────────
async function getNoteStats(userId) {
    const [noteCount, chatCount, feedbackAvg, recentFeedback] = await Promise.all([
        _dbGet(`SELECT COUNT(*) as cnt FROM notes WHERE user_id=?`, [userId]),
        _dbGet(`SELECT COUNT(*) as cnt FROM chat_logs WHERE user_id=?`, [userId]),
        _dbGet(
            `SELECT AVG(f.score) as avg_score
               FROM note_feedbacks f
               JOIN notes n ON n.id = f.note_id
              WHERE n.user_id=?`,
            [userId]
        ),
        _dbAll(
            `SELECT f.score, f.created_at, n.title
               FROM note_feedbacks f
               JOIN notes n ON n.id = f.note_id
              WHERE n.user_id=?
              ORDER BY f.created_at DESC
              LIMIT 5`,
            [userId]
        ),
    ]);

    return {
        noteCount     : noteCount?.cnt  || 0,
        chatCount     : chatCount?.cnt  || 0,
        avgScore      : Math.round(feedbackAvg?.avg_score || 0),
        recentFeedback: recentFeedback  || [],
        cacheStats    : noteCache.stats(),
        queueStats    : {
            semaphoreWaiting: aiSemaphore.waiting,
            circuitOpen     : circuit.isOpen(),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    injectDb,
    generateNote,
    generateFeedback,
    enqueueJob,
    getJobStatus,
    getNoteStats,
    recoverPendingJobs,
    noteCache,         // 캐시 직접 접근 (무효화 용)
    rateLimiter,
};