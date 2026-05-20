/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                        aiNoteService.js                                  ║
 * ║              나만의 AI 노트 서비스 – 핵심 비즈니스 로직                         ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                          ║
 * ║  [역할] 사용자의 노트와 챗봇 질문 이력을 분석해 AI 피드백을 생성하는               ║
 * ║         서비스 레이어. Express 라우터(routes/aiNotes.js)에서 호출된다.           ║
 * ║                                                                          ║
 * ║  [대규모 트래픽 대응 전략]                                                    ║
 * ║   1. LRU 캐시      – 동일 요청은 AI 호출 없이 즉시 반환 (응답 속도 ↑)            ║
 * ║   2. Rate Limiter  – 사용자당 분당 5회 제한 (AI 서버 과부하 방지)               ║
 * ║   3. Semaphore     – AI 동시 호출을 최대 3개로 제한 (메모리 보호)               ║
 * ║   4. Circuit Breaker – AI 서버 연속 5회 실패 시 60초 차단 (장애 전파 방지)      ║
 * ║   5. Job Queue     – DB 기반 비동기 작업 큐 (서버 재시작 시 자동 복구)           ║
 * ║                                                                          ║
 * ║  [AI 피드백 설계 - Chain-of-Thought 방식]                                  ║
 * ║   · System Prompt  – AI 튜터 역할 + 절대 규칙 정의                            ║
 * ║   · User Prompt    – 5차원 분석 데이터 구조화하여 전달                          ║
 * ║   · 호출 순서       Anthropic API → Python AI → 로컬 fallback               ║
 * ║                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

// axios: HTTP 클라이언트 라이브러리
// Python AI 서버(8000번)와 Anthropic API 호출에 모두 사용
const axios = require('axios');

// ══════════════════════════════════════════════════════════════════════════════
// 설정 상수
// 환경변수(process.env)로 외부에서 주입 가능하게 설계 → 배포 환경 유연성 확보
// ══════════════════════════════════════════════════════════════════════════════
const PYTHON_AI_SERVER    = process.env.AI_SERVER || 'http://127.0.0.1:8000'; // Python AI 서버 주소
const AI_TIMEOUT_MS       = 120_000;  // AI 응답 최대 대기 시간 (2분)
const CACHE_TTL_MS        = 10 * 60 * 1000; // 캐시 유효 시간 (10분)
const CACHE_MAX_SIZE      = 200;       // 캐시 최대 항목 수
const RATE_LIMIT_PER_MIN  = 5;        // 사용자당 분당 최대 요청 수
const MAX_CONCURRENT_AI   = 3;        // AI 서버 동시 호출 최대 수
const CIRCUIT_BREAK_THRESHOLD = 5;   // Circuit Breaker 발동 연속 실패 횟수
const CIRCUIT_RESET_MS    = 60_000;  // Circuit Breaker 리셋 시간 (1분)

// ── DB 헬퍼 함수 (의존성 주입 패턴) ──────────────────────────────────────────
// 직접 require('./db')하지 않고 index.js에서 주입받는 이유:
//  - 순환 참조(circular dependency) 방지
//  - 테스트 시 mock DB 주입 가능
let _dbAll, _dbRun, _dbGet;
function injectDb(dbAll, dbRun, dbGet) {
    _dbAll = dbAll; // SELECT 다중 행
    _dbRun = dbRun; // INSERT / UPDATE / DELETE
    _dbGet = dbGet; // SELECT 단일 행
}

// ══════════════════════════════════════════════════════════════════════════════
// [1] LRU 캐시 (Least Recently Used)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Map의 삽입 순서 특성을 이용한 경량 LRU 캐시.
 * 외부 라이브러리 없이 구현해 의존성 최소화.
 *
 * 동작 원리:
 *  - get() 시 해당 항목을 Map 맨 뒤로 이동 (최근 사용 = 뒤)
 *  - 용량 초과 시 Map 맨 앞(가장 오래된 항목) 제거
 *  - TTL 초과 항목은 get() 시점에 즉시 삭제
 *
 * 적용 효과: 동일한 북마크 조합으로 노트 요청 시 AI 호출 없이 즉시 응답
 */
class LRUCache {
    constructor(maxSize, ttlMs) {
        this.maxSize = maxSize; // 최대 항목 수
        this.ttlMs   = ttlMs;  // 항목 유효 시간(ms)
        this.map     = new Map();
    }

    // 캐시 키: "userId:modelId1,modelId2" (정렬하여 순서 무관하게 동일 키 생성)
    _key(uid, ids) { return `${uid}:${[...ids].sort().join(',')}`; }

    get(uid, ids) {
        const key  = this._key(uid, ids);
        const item = this.map.get(key);
        if (!item) return null;
        // TTL 만료 확인
        if (Date.now() - item.ts > this.ttlMs) { this.map.delete(key); return null; }
        // LRU 갱신: 삭제 후 맨 뒤에 재삽입
        this.map.delete(key);
        this.map.set(key, item);
        return item.value;
    }

    set(uid, ids, value) {
        const key = this._key(uid, ids);
        if (this.map.has(key)) this.map.delete(key); // 기존 항목 제거
        // 용량 초과 시 가장 오래된 항목(Map 첫 번째) 제거
        if (this.map.size >= this.maxSize) this.map.delete(this.map.keys().next().value);
        this.map.set(key, { value, ts: Date.now() });
    }

    // 특정 사용자의 캐시 전체 무효화 (노트 수정 시 호출)
    invalidateUser(uid) {
        for (const k of this.map.keys()) if (k.startsWith(`${uid}:`)) this.map.delete(k);
    }

    stats() { return { size: this.map.size, maxSize: this.maxSize }; }
}
const noteCache = new LRUCache(CACHE_MAX_SIZE, CACHE_TTL_MS);

// ══════════════════════════════════════════════════════════════════════════════
// [2] Rate Limiter (슬라이딩 윈도우 방식)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 고정 윈도우(Fixed Window) 방식이 아닌 슬라이딩 윈도우(Sliding Window)를 사용.
 *
 * 고정 윈도우 문제점: 윈도우 경계에서 2배 요청 가능
 *   예) 0:59초에 5회 + 1:00초에 5회 = 1초 안에 10회
 *
 * 슬라이딩 윈도우: 현재 시각 기준 60초 이내 요청만 카운트
 *   → 언제든 60초 안에 최대 5회만 허용
 *
 * 적용 효과: 악의적 사용자나 실수로 인한 AI 서버 과부하 방지
 */
class RateLimiter {
    constructor(max) {
        this.max    = max;        // 윈도우당 최대 요청 수
        this.window = 60_000;    // 슬라이딩 윈도우 크기 (60초)
        this.map    = new Map(); // userId → 요청 타임스탬프 배열
    }

    check(uid) {
        const now  = Date.now();
        // 60초 이내 요청만 남기고 나머지 제거 (슬라이딩)
        const hits = (this.map.get(uid) || []).filter(t => now - t < this.window);
        if (hits.length >= this.max) {
            // retryAfter: 가장 오래된 요청이 윈도우 밖으로 나가는 시간
            return { allowed: false, retryAfter: Math.ceil((this.window - (now - hits[0])) / 1000) };
        }
        hits.push(now);
        this.map.set(uid, hits);
        return { allowed: true };
    }

    // 메모리 누수 방지: 60초마다 만료된 사용자 데이터 삭제
    _cleanup() {
        const now = Date.now();
        for (const [uid, hits] of this.map) {
            const fresh = hits.filter(t => now - t < this.window);
            if (!fresh.length) this.map.delete(uid); else this.map.set(uid, fresh);
        }
    }
}
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MIN);
setInterval(() => rateLimiter._cleanup(), 60_000); // 1분마다 정리

// ══════════════════════════════════════════════════════════════════════════════
// [3] Semaphore (동시 AI 호출 제한)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Promise 기반 세마포어. AI 서버 동시 요청 수를 MAX_CONCURRENT_AI(3)개로 제한.
 *
 * 필요한 이유:
 *  - Qwen 모델은 GPU/CPU 메모리를 많이 사용
 *  - 동시 요청이 많으면 OOM(Out of Memory) 또는 타임아웃 발생
 *  - 세마포어로 대기열 구성 → 순차 처리로 안정성 확보
 *
 * acquire(): 슬롯이 있으면 즉시 진입, 없으면 Promise로 대기
 * release(): 슬롯 반납, 대기 중인 Promise 하나 실행
 */
class Semaphore {
    constructor(max) { this.max = max; this.current = 0; this.queue = []; }

    acquire() {
        return new Promise(resolve => {
            if (this.current < this.max) { this.current++; resolve(); }
            else this.queue.push(resolve); // 슬롯 없으면 대기열에 추가
        });
    }

    release() {
        this.current--;
        if (this.queue.length) { this.current++; this.queue.shift()(); } // 대기 중인 것 하나 실행
    }

    get waiting() { return this.queue.length; } // 현재 대기 중인 요청 수
}
const aiSemaphore = new Semaphore(MAX_CONCURRENT_AI);

// ══════════════════════════════════════════════════════════════════════════════
// [4] Circuit Breaker (장애 자동 감지 및 차단)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * AI 서버 장애 시 무한 재시도로 인한 자원 낭비를 방지.
 *
 * 3가지 상태:
 *  CLOSED (정상): 모든 요청 통과
 *  OPEN   (차단): 연속 5회 실패 후 60초간 모든 요청 즉시 거부
 *  HALF-OPEN(재시도): 60초 후 자동으로 CLOSED로 전환 시도
 *
 * 적용 효과:
 *  - AI 서버 장애 시 즉시 Anthropic/로컬 fallback으로 전환
 *  - 장애 서버에 계속 요청 보내지 않아 복구 시간 단축
 */
const circuit = {
    failures : 0,    // 연속 실패 횟수
    openedAt : 0,    // Circuit 열린 시각(ms)

    isOpen() {
        if (this.failures < CIRCUIT_BREAK_THRESHOLD) return false; // CLOSED
        if (Date.now() - this.openedAt > CIRCUIT_RESET_MS) {
            // HALF-OPEN: 60초 지났으면 다시 시도 허용
            this.failures = 0;
            return false;
        }
        return true; // OPEN
    },

    onSuccess() { this.failures = 0; },  // 성공 시 카운터 초기화
    onFailure() {
        this.failures++;
        if (this.failures === CIRCUIT_BREAK_THRESHOLD) {
            this.openedAt = Date.now();
            console.warn(`[Circuit] OPEN: AI 서버 ${CIRCUIT_BREAK_THRESHOLD}회 연속 실패`);
        }
    },
};

// ══════════════════════════════════════════════════════════════════════════════
// [5] AI 서버 호출 함수들
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Python AI 서버 (Qwen 모델) 호출 – 노트 생성용
 *
 * Semaphore와 Circuit Breaker를 모두 통과해야 실제 HTTP 요청 전송.
 * finally 블록에서 반드시 Semaphore 반납 → 슬롯 누수 방지
 *
 * @param {string} prompt - AI에게 전달할 프롬프트
 * @returns {string|null} AI 응답 텍스트
 */
async function callAI(prompt) {
    if (circuit.isOpen()) throw new Error('AI_CIRCUIT_OPEN'); // Circuit 열려있으면 즉시 실패
    await aiSemaphore.acquire(); // 슬롯 대기
    try {
        const resp = await axios.post(
            `${PYTHON_AI_SERVER}/chat`,
            { message: prompt, subject: '', with_quiz: false },
            { timeout: AI_TIMEOUT_MS }
        );
        circuit.onSuccess();
        return resp.data?.answer || null;
    } catch (err) {
        circuit.onFailure(); // 실패 카운트 증가
        throw err;
    } finally {
        aiSemaphore.release(); // 성공/실패 관계없이 슬롯 반납
    }
}

/**
 * Anthropic API (Claude Sonnet) 호출 – 피드백 전용
 *
 * Qwen 0.5B 소형 모델은 복잡한 JSON 구조화 지시를 따르지 못하는 한계가 있음.
 * 피드백은 5차원 분석 + Chain-of-Thought 방식의 복잡한 프롬프트를 사용하므로
 * Claude Sonnet처럼 지시 이행 능력이 높은 모델이 필요.
 *
 * System/User 프롬프트 분리:
 *  - system: AI의 역할, 절대 규칙 (변하지 않는 지시)
 *  - user  : 실제 분석할 데이터 (매 요청마다 달라지는 데이터)
 *
 * @param {string} systemPrompt - AI 역할 및 규칙 정의
 * @param {string} userPrompt   - 분석할 학생 데이터
 * @returns {string|null} JSON 형태의 피드백 텍스트
 */
async function callAnthropicForFeedback(systemPrompt, userPrompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 없음');

    const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model     : 'claude-sonnet-4-20250514', // 지시 이행 능력이 높은 모델 선택
            max_tokens: 2048,                        // 상세한 피드백을 위해 충분한 토큰 확보
            system    : systemPrompt,
            messages  : [{ role: 'user', content: userPrompt }],
        },
        {
            timeout: 60000,
            headers: {
                'x-api-key'        : apiKey,
                'anthropic-version': '2023-06-01',
                'content-type'     : 'application/json',
            },
        }
    );
    return resp.data?.content?.[0]?.text || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// [6] 노트 생성 헬퍼
// ══════════════════════════════════════════════════════════════════════════════

/**
 * AI 없이 생성하는 기본 노트 템플릿 (모든 AI가 실패했을 때 최종 fallback)
 *
 * 사용자에게 빈 화면 대신 구조화된 시작점을 제공해
 * 직접 내용을 채울 수 있도록 가이드 역할을 한다.
 */
function buildFallbackNote(bookmarks, chatRows) {
    return [
        '# 📚 핵심 개념',
        bookmarks.length
            ? bookmarks.map(m => `- **${m.title}**: ${m.description || '북마크한 개념'}`).join('\n')
            : '- 아직 북마크한 개념이 없습니다.',
        '', '# 💬 질문으로 보강한 내용',
        chatRows.length
            ? chatRows.map(r => `- ${r.message}`).join('\n')
            : '- 관련 챗봇 질문 기록이 없습니다.',
        '', '# 🔄 다시 확인할 개념',
        '- 퀴즈 요청 기록이 생기면 여기에 표시됩니다.',
        '', '# ✏️ 직접 보완할 부분',
        '- 이 부분에 스스로 정리한 내용을 추가해보세요.',
    ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// [7] 노트 품질 분석 (analyzeNoteDepth)
// ══════════════════════════════════════════════════════════════════════════════

// 과목 코드 → 한국어 변환 테이블
const SUBJECT_KO = {
    biology  : '생명과학', physics  : '물리학',
    chemistry: '화학',     earth    : '지구과학',
    geography: '지리학',
};

/**
 * 노트 텍스트를 정량적으로 분석해 AI 프롬프트에 전달할 수치 데이터를 생성.
 *
 * 분석 항목:
 *  - 분량 지표: 글자 수, 줄 수, 문장 수
 *  - 구조 지표: 마크다운 헤더 수, 불릿 수, 고유 한글 키워드 수
 *  - 내용 지표: 예시/공식/요약/정의/연결어/질문 포함 여부 (boolean)
 *  - 등급 및 점수 상한: 글자 수 기반 6등급(F~S)으로 점수 상한 결정
 *
 * 점수 상한을 두는 이유:
 *  "생명이란 무엇인가?" 한 줄짜리 노트가 85점을 받는 부조리 방지.
 *  아무리 AI가 후한 점수를 줘도 등급 상한을 초과할 수 없다.
 *
 * @param {Object} note - notes 테이블 레코드
 * @returns {Object} 분석 결과 객체
 */
function analyzeNoteDepth(note) {
    const content = note.content || '';

    // ── 분량 지표 ─────────────────────────────────────────────────────────
    const lines     = content.split('\n').filter(l => l.trim());
    const charLen   = content.length;
    const sentences = (content.match(/[.!?。]\s|\n/g) || []).length + 1;

    // ── 구조 지표 ─────────────────────────────────────────────────────────
    const sections = (content.match(/^#+\s/gm) || []).length;   // # 헤더 수
    const bullets  = (content.match(/^[-*]\s/gm) || []).length; // - / * 불릿 수
    const keywords = [...new Set((content.match(/[가-힣]{2,8}/g) || []))].length; // 고유 한글 단어 수

    // ── 내용 지표 (정규식으로 특정 패턴 존재 여부 확인) ───────────────────
    const hasExamples   = /예시|예를 들|예를들|예:|가령/.test(content);
    const hasFormula    = /공식|식:|수식|\$|=/.test(content);
    const hasSummary    = /요약|정리|핵심|결론/.test(content);
    const hasDefinition = /이란|이다\.|란\s|정의|개념|의미/.test(content);
    const hasConnection = /따라서|그러므로|왜냐하면|때문에|관련|연결|비교|반면/.test(content);
    const hasQuestion   = /\?|왜|어떻게|무엇|언제/.test(content);

    // ── 등급 및 점수 상한 결정 ────────────────────────────────────────────
    let grade, gradeDesc;
    if      (charLen < 20)  { grade = 'F'; gradeDesc = '내용 없음 수준'; }
    else if (charLen < 80)  { grade = 'D'; gradeDesc = '단편적 메모 수준'; }
    else if (charLen < 200) { grade = 'C'; gradeDesc = '기초 정리 수준'; }
    else if (charLen < 500) { grade = 'B'; gradeDesc = '보통 학습 수준'; }
    else if (charLen < 1000){ grade = 'A'; gradeDesc = '충실한 정리 수준'; }
    else                    { grade = 'S'; gradeDesc = '심화 학습 수준'; }

    const maxScore = { F:15, D:30, C:50, B:75, A:90, S:100 }[grade];

    return {
        charLen, lines: lines.length, sentences, sections, bullets, keywords,
        hasExamples, hasFormula, hasSummary, hasDefinition, hasConnection, hasQuestion,
        grade, gradeDesc, maxScore,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// [8] 챗봇 질문 패턴 분석 (analyzeChatPattern)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 사용자의 챗봇 질문 이력을 분석해 학습 패턴과 약점을 추출.
 *
 * 분석 항목:
 *  1. 과목별 질문 빈도  → 관심 분야 파악
 *  2. 반복 키워드      → 자주 헷갈리는 개념 후보 (불용어 제외, 2회 이상)
 *  3. 퀴즈 요청 메시지 → 자신감 없는 개념 = 약점 후보
 *  4. 최근 질문 10개   → AI에게 최근 학습 맥락 전달
 *
 * 불용어(STOPWORDS) 처리 이유:
 *  "무엇", "어떻게" 같은 의문사는 어느 질문에나 등장하므로
 *  반복 키워드 분석에서 제외해야 실제 의미 있는 개념만 추출 가능.
 *
 * @param {Array} chatRows - chat_logs 테이블 레코드 배열
 * @returns {Object} 패턴 분석 결과
 */
function analyzeChatPattern(chatRows) {
    // ── 1. 과목별 빈도 계산 ────────────────────────────────────────────────
    const subjectCount = {};
    for (const r of chatRows) {
        const s = r.subject || 'general';
        subjectCount[s] = (subjectCount[s] || 0) + 1;
    }
    // 빈도 내림차순 정렬 후 상위 3개, "생명과학(8회)" 형태로 포맷
    const topSubjects = Object.entries(subjectCount)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([s, cnt]) => `${SUBJECT_KO[s] || s}(${cnt}회)`);

    // ── 2. 반복 키워드 추출 ────────────────────────────────────────────────
    // 학습과 무관한 의문사·조사 등 불용어 목록
    const STOPWORDS = new Set([
        '이란','무엇','어떻게','왜','설명','알려','해줘','해주세요','대해','에서',
        '이다','하는','있는','나요','이유','방법','차이','관계','종류','특징',
        '예시','원리','공식','정의','개념','의미','뭔가요','뭐야','가요',
    ]);
    const wordFreq = {};
    for (const r of chatRows) {
        // 2~6글자 한글 단어만 추출 (단어 경계가 없는 한국어 특성상 길이로 필터)
        for (const w of (r.message || '').match(/[가-힣]{2,6}/g) || []) {
            if (!STOPWORDS.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
        }
    }
    // 2회 이상 등장한 키워드를 빈도 내림차순으로 상위 8개 선택
    const repeatedKeywords = Object.entries(wordFreq)
        .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([w, c]) => `"${w}"(${c}회)`);

    // ── 3. 퀴즈 요청 = 자신감 없는 개념 ──────────────────────────────────
    const quizMsgs   = chatRows.filter(r => r.with_quiz).map(r => r.message);

    // ── 4. 최근 질문 10개 (맥락 전달용) ──────────────────────────────────
    const recentMsgs = chatRows.slice(0, 10).map(r => r.message);
    const allMsgs    = chatRows.map(r => r.message);

    return { topSubjects, repeatedKeywords, quizMsgs, recentMsgs, allMsgs, totalQuestions: chatRows.length, wordFreq };
}

// ══════════════════════════════════════════════════════════════════════════════
// [9] Chain-of-Thought 피드백 프롬프트 빌더
// ══════════════════════════════════════════════════════════════════════════════

/**
 * System Prompt: AI 튜터의 역할과 절대 규칙을 정의.
 *
 * System/User 분리 전략:
 *  - system: 역할과 규칙 → 모든 요청에서 동일, 모델이 "페르소나"를 유지
 *  - user  : 실제 데이터 → 요청마다 달라지는 개인화 데이터
 *
 * 이렇게 분리하면 LLM이 system 지시를 더 강하게 따르는 경향이 있음.
 */
function buildFeedbackSystemPrompt() {
    return `당신은 대한민국 중고등학생의 학습을 돕는 전문 AI 튜터입니다.
학생의 노트와 챗봇 질문 이력을 분석하여 아래 5가지 차원에서 심층 피드백을 제공합니다.

[분석 5차원]
1. 개념 이해도  : 노트에 개념의 정의·예시·공식·연결이 얼마나 담겼는지
2. 학습 패턴    : 챗봇 질문 빈도·과목·반복 키워드로 관심사와 습관 파악
3. 노트 품질    : 구조(섹션/불릿/요약), 분량, 자신의 언어로 재구성 여부
4. 약점 진단    : 퀴즈 요청·반복 질문·설명 없는 개념에서 취약점 추출
5. 성장 가능성  : 현재 수준 대비 다음 단계 구체적 행동 제시

[절대 규칙]
- 반드시 순수 JSON만 출력. 코드블록(\`\`\`), 설명 텍스트 절대 금지.
- strengths/improvements/weak_areas 항목에 노트 원문 문장을 절대 복사하지 말 것.
- score는 지정된 maxScore를 절대 초과하지 말 것.
- 모든 항목은 실제 데이터에 근거한 개인화 내용으로만 작성.
- 각 피드백 항목은 최소 2문장 이상, 구체적 수치나 예시 포함.`;
}

/**
 * User Prompt: 5차원 분석에 필요한 학생 데이터를 구조화해 전달.
 *
 * Chain-of-Thought 적용:
 *  - 단순히 "피드백 줘"가 아니라 분석 데이터를 섹션별로 정리해 제공
 *  - AI가 데이터를 보며 "단계적으로 추론"하도록 유도
 *  - 누락 개념(챗봇에서 물었지만 노트에 없는 키워드) 자동 계산해 전달
 *
 * @param {Object} note     - 분석할 노트 레코드
 * @param {Array}  chatRows - 사용자의 챗봇 질문 이력
 * @param {Array}  allNotes - 사용자의 다른 노트 목록 (학습 범위 맥락용)
 * @returns {string} 구조화된 분석 요청 프롬프트
 */
function buildFeedbackUserPrompt(note, chatRows, allNotes) {
    const depth = analyzeNoteDepth(note);
    const chat  = analyzeChatPattern(chatRows);

    // 이전 노트 제목 목록: AI가 학생의 전체 학습 범위를 파악하는 데 활용
    const noteHistory = (allNotes || []).filter(n => n.id !== note.id).map(n => n.title).slice(0, 8);

    // 노트에 등장하는 한글 키워드 추출
    const noteKeywords = [...new Set((note.content || '').match(/[가-힣]{2,8}/g) || [])].slice(0, 20);

    // 챗봇에서 2회 이상 물었지만 노트에 없는 키워드 → 누락 개념 후보
    // 이것이 약점 진단의 핵심 근거가 된다
    const missingInNote = Object.entries(chat.wordFreq)
        .filter(([w, c]) => c >= 2 && !noteKeywords.includes(w))
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);

    return `아래 학생 데이터를 분석하여 Chain-of-Thought 방식으로 깊이 있게 피드백하세요.

## 학생 노트 정보
- 제목: ${note.title}
- 과목: ${SUBJECT_KO[note.subject || ''] || note.subject || '미분류'}
- 분량: ${depth.charLen}자 / ${depth.lines}줄 / ${depth.sentences}문장
- 구조: 섹션헤더 ${depth.sections}개, 불릿 ${depth.bullets}개, 고유키워드 ${depth.keywords}개
- 포함 요소: 정의(${depth.hasDefinition ? '✓' : '✗'}) 예시(${depth.hasExamples ? '✓' : '✗'}) 공식(${depth.hasFormula ? '✓' : '✗'}) 연결어(${depth.hasConnection ? '✓' : '✗'}) 요약(${depth.hasSummary ? '✓' : '✗'}) 질문형(${depth.hasQuestion ? '✓' : '✗'})
- 노트 품질 등급: ${depth.grade}등급 (${depth.gradeDesc}) → score 상한: ${depth.maxScore}점

## 노트 전문
${note.content || '(내용 없음)'}

## 챗봇 질문 분석 (총 ${chat.totalQuestions}회)
- 주요 관심 과목: ${chat.topSubjects.join(', ') || '없음'}
- 반복 언급 키워드: ${chat.repeatedKeywords.join(', ') || '없음'}
- 퀴즈 요청(자신감 부족): ${chat.quizMsgs.slice(0, 5).map(m => `"${m}"`).join(' / ') || '없음'}
- 최근 질문 10개:
${chat.recentMsgs.map((m, i) => `  ${i + 1}. ${m}`).join('\n') || '  없음'}

## 연관도 분석
- 챗봇에서 물었지만 노트에 없는 개념(누락 후보): ${missingInNote.join(', ') || '없음'}

## 이전 학습 노트 (학습 범위 맥락)
${noteHistory.map((t, i) => `${i + 1}. ${t}`).join('\n') || '없음'}

---
## 출력 형식 (순수 JSON, 절대 다른 텍스트 없이)
{
  "score": <0~${depth.maxScore} 정수, 이 상한 절대 초과 금지>,
  "grade": "${depth.grade}",
  "summary": "<이 학생의 현재 학습 상태를 2문장으로 요약. 노트 등급과 챗봇 패턴 모두 언급>",
  "concept_analysis": "<개념 이해도: 잘 이해한 개념과 표면적으로만 언급된 개념 구분, 3~4문장 구체적 서술>",
  "learning_pattern": "<학습 패턴: 질문 빈도·과목 편향·퀴즈 요청 패턴을 근거로 학습 습관 3~4문장 서술>",
  "weak_areas": [
    "<약점1: 챗봇 반복 질문이나 퀴즈 요청 근거, '~을 여러 번 질문했지만 노트에 정리 안 됨' 형태>",
    "<약점2>", "<약점3>"
  ],
  "interest_areas": ["<관심분야1>", "<관심분야2>"],
  "strengths": [
    "<잘한점1: 노트 구조/키워드/분량 등 실제 데이터 근거, 원문 복사 절대 금지>",
    "<잘한점2>"
  ],
  "improvements": [
    "<개선점1: 오늘 당장 실행 가능한 구체적 행동, 누락 개념 직접 언급>",
    "<개선점2>", "<개선점3>"
  ],
  "next_step": "<다음에 해야 할 가장 중요한 학습 행동 1가지, 어떤 개념을 어떤 방법으로 얼마나 할지 3문장>"
}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// [10] 로컬 Fallback 피드백 (AI 모두 실패 시)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Anthropic API와 Python AI 모두 실패했을 때 사용하는 로컬 계산 피드백.
 *
 * AI 없이도 의미 있는 피드백을 제공하는 전략:
 *  - analyzeNoteDepth()의 수치 지표로 점수 계산
 *  - analyzeChatPattern()의 퀴즈 요청/반복 키워드로 약점 추출
 *  - 등급별(F~S) 미리 설계된 맞춤 메시지 제공
 *
 * 이렇게 하면 AI 서버 전체 장애 시에도 사용자가 의미 있는 피드백을 받을 수 있다.
 */
function buildLocalFallbackFeedback(note, chatRows) {
    const depth = analyzeNoteDepth(note);
    const chat  = analyzeChatPattern(chatRows);

    // 기본 점수: 등급별 시작점 + 구조 요소 보너스
    const baseScore = { F:5, D:15, C:30, B:55, A:70, S:85 }[depth.grade];
    const bonus     = (depth.sections > 0 ? 3 : 0) + (depth.bullets > 2 ? 3 : 0)
                    + (depth.hasExamples ? 5 : 0) + (depth.hasDefinition ? 3 : 0)
                    + (depth.hasConnection ? 3 : 0) + (depth.hasSummary ? 3 : 0);
    const score     = Math.min(depth.maxScore, baseScore + bonus);

    // 퀴즈 요청 메시지에서 약점 키워드 추출
    const weakAreas = chat.quizMsgs.slice(0, 2).map(m => {
        const kw = (m.match(/[가-힣]{2,6}/g) || []).slice(0, 2).join(' ');
        return kw ? `${kw}: 챗봇에 퀴즈를 요청한 것으로 보아 아직 개념이 확실하지 않습니다.` : null;
    }).filter(Boolean);
    if (!weakAreas.length) weakAreas.push('챗봇 질문을 더 해보면 약점 개념을 정확히 파악할 수 있습니다.');

    // 챗봇에서 2회 이상 언급했지만 노트에 없는 키워드 = 누락 개념
    const noteKw  = new Set((note.content || '').match(/[가-힣]{2,6}/g) || []);
    const missing = Object.entries(chat.wordFreq)
        .filter(([w, c]) => c >= 2 && !noteKw.has(w))
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);

    // 등급별 맞춤 메시지 (미리 설계된 규칙 기반 피드백)
    const gradeMsg = {
        F: { summary: '노트 내용이 거의 없습니다. 지금 바로 내용을 채워야 학습 효과를 기대할 수 있습니다.',
             improvement: '제목과 관련된 핵심 정의를 최소 3줄 이상 직접 작성해보세요. 챗봇에 "○○이란 무엇인가요?"라고 질문한 후 답변을 요약해 노트에 추가하세요.' },
        D: { summary: '노트가 메모 수준에 그치고 있습니다. 각 개념에 자신의 언어로 설명을 추가해야 합니다.',
             improvement: '현재 내용 아래에 "이 개념이 중요한 이유"를 2문장 추가해보세요. 관련 예시도 1개 이상 붙여보세요.' },
        C: { summary: '기초적인 내용을 담고 있으나 설명이 단편적입니다. 개념 간 연결과 예시가 부족합니다.',
             improvement: '각 개념마다 실생활 예시를 1개씩 추가하고, 개념들 간의 차이를 1줄로 정리해보세요.' },
        B: { summary: '보통 수준의 노트입니다. 내용은 있지만 심화 설명과 개념 연결이 부족합니다.',
             improvement: '각 섹션 마지막에 핵심 1문장 요약을 추가하고, 다른 단원 개념과의 연관성을 화살표(→)로 표시해보세요.' },
        A: { summary: '충실하게 작성된 노트입니다. 이제 암기보다 응용과 연결에 집중할 때입니다.',
             improvement: '이 노트 내용으로 직접 문제 3개를 만들어보세요. 챗봇에 풀어달라고 하면 이해도를 확인할 수 있습니다.' },
        S: { summary: '매우 심화된 학습 노트입니다. 다른 단원·과목과 융합하는 단계로 나아갈 때입니다.',
             improvement: '이 개념을 다른 과목과 연결하는 융합 정리를 만들어보세요.' },
    }[depth.grade];

    return {
        score,
        grade         : depth.grade,
        summary       : `노트 분량 ${depth.charLen}자(${depth.grade}등급)로 ${gradeMsg.summary} 챗봇 질문 ${chat.totalQuestions}회 중 ${chat.topSubjects[0] || '특정 과목'} 관련 질문이 가장 많습니다.`,
        concept_analysis: `노트에 ${depth.keywords}개의 고유 개념 키워드가 포함되어 있으며, 정의(${depth.hasDefinition ? '있음' : '없음'})/예시(${depth.hasExamples ? '있음' : '없음'})/연결어(${depth.hasConnection ? '있음' : '없음'}) 구성입니다. ${missing.length ? `챗봇에서 "${missing.join('", "')}"을 반복 질문했지만 노트에 정리되지 않아 실제 이해로 이어지지 않을 수 있습니다.` : '챗봇 질문 기록이 부족해 개념 이해도를 정확히 파악하기 어렵습니다.'}`,
        learning_pattern: `챗봇 질문 총 ${chat.totalQuestions}회로 ${chat.totalQuestions >= 10 ? '적극적으로 질문하는 학습 습관이 있습니다.' : chat.totalQuestions >= 3 ? '기본적인 질문 습관이 있으나 더 자주 활용하면 좋겠습니다.' : '챗봇 활용이 매우 적습니다. 모르는 내용이 있을 때마다 즉시 질문하는 습관을 들이세요.'} ${chat.topSubjects.length ? `${chat.topSubjects[0].replace(/\(\d+회\)/, '').trim()} 분야에 집중된 학습 패턴입니다.` : ''} ${chat.quizMsgs.length ? `퀴즈를 ${chat.quizMsgs.length}회 요청한 것으로 보아 자기 검증 의식이 있습니다.` : ''}`,
        weak_areas    : weakAreas,
        interest_areas: chat.topSubjects.map(s => s.replace(/\(\d+회\)/, '').trim()),
        strengths     : [
            depth.charLen > 200
                ? `${depth.charLen}자 분량으로 ${depth.grade}등급 수준의 학습 노트를 완성했습니다.`
                : '노트를 작성하려는 의지가 있습니다. 지금부터 내용을 채워가면 됩니다.',
            depth.hasExamples ? '예시를 통해 추상적 개념을 구체화하는 방식으로 정리했습니다.'
                : depth.sections > 0 ? '섹션을 나눠 내용을 체계적으로 구조화했습니다.'
                : '주제를 정하고 학습을 시작했습니다.',
        ],
        improvements  : [
            gradeMsg.improvement,
            missing.length
                ? `챗봇에서 반복 질문한 "${missing[0]}" 개념을 노트에 정리해보세요. 답변을 요약해 추가하면 이해도가 높아집니다.`
                : '모르는 개념이 생기면 챗봇에 즉시 질문하고, 답변을 요약해 노트에 추가하세요.',
            '노트 마지막에 "오늘 배운 것 3가지"를 직접 써보세요. 아무것도 보지 않고 쓸 수 있다면 완전히 이해한 것입니다.',
        ],
        next_step     : `지금 당장 "${note.title}" 노트를 열고 ${missing.length ? `"${missing[0]}" 개념의 정의를 자신의 언어로 2~3문장 작성` : '가장 중요한 개념의 예시를 1개 추가'}해보세요. 그 다음 챗봇에 "${note.title}에서 시험에 자주 나오는 문제를 3개 만들어줘"라고 질문해서 자기 테스트를 해보세요. 이 두 가지 행동만으로도 이해도가 눈에 띄게 향상됩니다.`,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// [11] 피드백 생성 메인 함수 (generateFeedback)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 피드백 생성 흐름:
 *
 *   [요청] → 캐시 확인 → (HIT) → 즉시 반환
 *                      → (MISS)
 *                         ↓
 *               DB 데이터 병렬 조회 (챗봇 이력 + 노트 목록)
 *                         ↓
 *               1차: Anthropic API (claude-sonnet)
 *                         ↓ (실패 시)
 *               2차: Python AI (Qwen)
 *                         ↓ (실패 시)
 *               3차: 로컬 fallback (규칙 기반 계산)
 *                         ↓
 *               점수 상한 강제 적용 (analyzeNoteDepth.maxScore)
 *                         ↓
 *               DB 저장 → 클라이언트 반환
 *
 * @param {number} userId - 요청한 사용자 ID
 * @param {number} noteId - 피드백을 생성할 노트 ID
 * @returns {Object} 피드백 결과 객체
 */
async function generateFeedback(userId, noteId) {
    // 노트 존재 및 소유권 확인
    const note = await _dbGet(`SELECT * FROM notes WHERE id=? AND user_id=?`, [noteId, userId]);
    if (!note) throw Object.assign(new Error('NOTE_NOT_FOUND'), { status: 404 });

    // 1시간 이내 캐시 재사용 (피드백은 노트 내용이 바뀌지 않으면 재생성 불필요)
    const existing = await _dbGet(
        `SELECT * FROM note_feedbacks WHERE note_id=? ORDER BY created_at DESC LIMIT 1`, [noteId]);
    if (existing) {
        const age = Date.now() - new Date(existing.created_at).getTime();
        if (age < 60 * 60 * 1000) { // 1시간 = 3600000ms
            return {
                feedback       : existing.feedback,
                summary        : existing.summary         || '',
                conceptAnalysis: existing.concept_analysis || '',
                learningPattern: existing.learning_pattern || '',
                nextStep       : existing.next_step        || '',
                strengths      : JSON.parse(existing.strengths       || '[]'),
                improvements   : JSON.parse(existing.improvements    || '[]'),
                weakAreas      : JSON.parse(existing.weak_areas      || '[]'),
                interestAreas  : JSON.parse(existing.interest_areas  || '[]'),
                score          : existing.score,
                grade          : existing.grade            || '',
                fromCache      : true, // 캐시에서 반환됨을 UI에 알림
            };
        }
    }

    // 분석에 필요한 데이터 병렬 조회 (Promise.all = 두 쿼리를 동시에 실행해 시간 단축)
    const [chatRows, allNotes] = await Promise.all([
        _dbAll(
            `SELECT message, subject, with_quiz, created_at
               FROM chat_logs WHERE user_id=? ORDER BY id DESC LIMIT 80`,
            [userId]
        ),
        _dbAll(
            `SELECT id, title, subject FROM notes WHERE user_id=? ORDER BY created_at DESC LIMIT 15`,
            [userId]
        ),
    ]);

    let parsed = null;

    // ── 1차: Anthropic API ────────────────────────────────────────────────
    try {
        const sysPrompt  = buildFeedbackSystemPrompt();
        const userPrompt = buildFeedbackUserPrompt(note, chatRows, allNotes);
        const answer     = await callAnthropicForFeedback(sysPrompt, userPrompt);
        if (answer) {
            // 응답에서 JSON 블록만 추출 (앞뒤 설명 텍스트 무시)
            const jsonMatch = answer.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
                console.log('[NoteService] Anthropic 피드백 성공');
            }
        }
    } catch (err) { console.warn('[NoteService] Anthropic 실패:', err.message); }

    // ── 2차: Python AI (Qwen) ────────────────────────────────────────────
    if (!parsed) {
        try {
            const userPrompt = buildFeedbackUserPrompt(note, chatRows, allNotes);
            const answer     = await callAI(userPrompt);
            if (answer) {
                const jsonMatch = answer.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[0]);
                    console.log('[NoteService] Python AI 피드백 성공');
                }
            }
        } catch (err) { console.warn('[NoteService] Python AI 실패:', err.message); }
    }

    // ── 3차: 로컬 fallback ────────────────────────────────────────────────
    if (!parsed) {
        parsed = buildLocalFallbackFeedback(note, chatRows);
        console.log('[NoteService] 로컬 fallback 피드백 사용');
    }

    // 점수 상한 강제 적용 (AI가 규칙을 어기더라도 코드 레벨에서 제한)
    const depth2 = analyzeNoteDepth(note);
    const score  = Math.min(depth2.maxScore, Math.max(0, parseInt(parsed.score) || 50));

    // DB 컬럼 동적 추가 (이전 버전 DB와 호환성 유지)
    for (const [col, def] of [
        ['summary',          "TEXT DEFAULT ''"],
        ['concept_analysis', "TEXT DEFAULT ''"],
        ['learning_pattern', "TEXT DEFAULT ''"],
        ['next_step',        "TEXT DEFAULT ''"],
        ['grade',            "TEXT DEFAULT ''"],
        ['weak_areas',       "TEXT DEFAULT '[]'"],
        ['interest_areas',   "TEXT DEFAULT '[]'"],
    ]) {
        try { await _dbRun(`ALTER TABLE note_feedbacks ADD COLUMN ${col} ${def}`); } catch (_) {}
    }

    // DB에 피드백 저장
    await _dbRun(
        `INSERT INTO note_feedbacks
           (note_id, user_id, feedback, summary, concept_analysis, learning_pattern,
            next_step, strengths, improvements, score, grade, weak_areas, interest_areas)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            noteId, userId,
            parsed.summary || parsed.feedback || '',
            parsed.summary || '',
            parsed.concept_analysis || '',
            parsed.learning_pattern || '',
            parsed.next_step        || '',
            JSON.stringify(parsed.strengths      || []),
            JSON.stringify(parsed.improvements   || []),
            score,
            parsed.grade || depth2.grade,
            JSON.stringify(parsed.weak_areas     || []),
            JSON.stringify(parsed.interest_areas || []),
        ]
    );

    return {
        feedback       : parsed.summary || parsed.feedback || '',
        summary        : parsed.summary        || '',
        conceptAnalysis: parsed.concept_analysis || '',
        learningPattern: parsed.learning_pattern || '',
        nextStep       : parsed.next_step        || '',
        strengths      : parsed.strengths        || [],
        improvements   : parsed.improvements     || [],
        weakAreas      : parsed.weak_areas       || [],
        interestAreas  : parsed.interest_areas   || [],
        score,
        grade          : parsed.grade || depth2.grade,
        fromCache      : false,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// [12] 노트 생성
// ══════════════════════════════════════════════════════════════════════════════

/**
 * AI 노트 생성 프롬프트 빌더.
 * 선택한 북마크와 관련 챗봇 질문을 컨텍스트로 제공해 맞춤형 초안을 생성.
 */
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

/**
 * 노트 생성 메인 함수.
 *
 * 흐름: LRU 캐시 확인 → Rate Limit 검사 → Python AI 시도 → fallback 템플릿
 *
 * 캐시 키 = "userId:modelId1,modelId2" (모델 ID 정렬해 순서 무관)
 * → 같은 북마크 조합을 다시 요청하면 AI 호출 없이 즉시 반환
 */
async function generateNote(userId, selectedModelIds, bookmarks, chatRows) {
    // 캐시 확인
    const cached = noteCache.get(userId, selectedModelIds);
    if (cached) {
        console.log(`[NoteService] 캐시 HIT (user=${userId})`);
        return { ...cached, fromCache: true };
    }

    // Rate Limit 검사
    const rl = rateLimiter.check(userId);
    if (!rl.allowed) throw Object.assign(new Error('RATE_LIMIT'), { retryAfter: rl.retryAfter });

    const titleBase = bookmarks.length === 1
        ? bookmarks[0].title
        : `${bookmarks[0].title} 외 ${bookmarks.length - 1}개`;

    let content = buildFallbackNote(bookmarks, chatRows);
    let aiUsed  = false;

    if (bookmarks.length || chatRows.length) {
        try {
            const answer = await callAI(buildNotePrompt(bookmarks, chatRows));
            if (answer) { content = answer.trim(); aiUsed = true; }
        } catch (err) {
            if (err.message !== 'AI_CIRCUIT_OPEN') console.warn('[NoteService] AI fallback:', err.message);
        }
    }

    const result = { title: `AI 학습 노트 - ${titleBase}`, content, subject: bookmarks[0]?.subject || '', aiUsed };
    noteCache.set(userId, selectedModelIds, result); // 결과 캐시 저장
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// [13] Job Queue (DB 기반 비동기 작업 큐)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Rate Limit 초과 또는 AI 서버 과부하 시 요청을 DB에 저장해 나중에 처리.
 *
 * DB 기반의 장점:
 *  - 서버가 재시작되어도 pending 작업이 사라지지 않음 (내구성)
 *  - recoverPendingJobs()로 서버 시작 시 자동 복구
 *  - 클라이언트는 jobId로 폴링해 완료 여부 확인
 *
 * 처리 순서: priority ASC, created_at ASC (우선순위 높은 것 먼저)
 */
let jobWorkerRunning = false;

/** 작업을 큐에 등록하고 jobId 반환 */
async function enqueueJob(userId, modelIds) {
    const r = await _dbRun(
        `INSERT INTO note_generation_jobs (user_id, model_ids, status) VALUES (?,?,'pending')`,
        [userId, JSON.stringify(modelIds)]
    );
    triggerWorker(); // 워커가 안 돌고 있으면 시작
    return r.lastID;
}

/** 작업 상태 조회 (클라이언트 폴링용) */
async function getJobStatus(jobId, userId) {
    return _dbGet(
        `SELECT id,status,result_note_id,error_msg,ai_used,created_at,updated_at
           FROM note_generation_jobs WHERE id=? AND user_id=?`,
        [jobId, userId]
    );
}

/** 워커가 실행 중이지 않으면 시작 */
function triggerWorker() { if (!jobWorkerRunning) processNextJob(); }

/**
 * 큐에서 작업 하나를 꺼내 처리.
 * setImmediate()로 이벤트 루프를 양보하며 재귀 호출 → 무한 루프 없이 계속 처리
 */
async function processNextJob() {
    jobWorkerRunning = true;
    try {
        // 가장 우선순위 높은 pending 작업 1개 조회
        const job = await _dbGet(
            `SELECT * FROM note_generation_jobs WHERE status='pending'
             ORDER BY priority ASC, created_at ASC LIMIT 1`
        );
        if (!job) { jobWorkerRunning = false; return; } // 큐 비어있으면 종료

        // 상태를 processing으로 업데이트 (중복 처리 방지)
        await _dbRun(
            `UPDATE note_generation_jobs SET status='processing', updated_at=datetime('now','localtime') WHERE id=?`,
            [job.id]
        );

        try {
            const modelIds  = JSON.parse(job.model_ids || '[]');
            const bRows     = await _dbAll(
                `SELECT model_id FROM bookmarks WHERE user_id=? AND model_id IN (${modelIds.map(() => '?').join(',')})`,
                [job.user_id, ...modelIds]
            );
            const bookmarks = bRows.map(r => ({ title: `개념 #${r.model_id}`, description: '', subject: '' }));
            const chatRows  = await _dbAll(
                `SELECT message,subject,with_quiz FROM chat_logs WHERE user_id=? ORDER BY id DESC LIMIT 80`,
                [job.user_id]
            );
            const { title, content, subject, aiUsed } = await generateNote(job.user_id, modelIds, bookmarks, chatRows);
            const ins = await _dbRun(
                `INSERT INTO notes (user_id,title,content,subject) VALUES (?,?,?,?)`,
                [job.user_id, title, content, subject]
            );
            // 완료 처리
            await _dbRun(
                `UPDATE note_generation_jobs SET status='done',result_note_id=?,ai_used=?,updated_at=datetime('now','localtime') WHERE id=?`,
                [ins.lastID, aiUsed ? 1 : 0, job.id]
            );
        } catch (err) {
            // 실패 처리 (에러 메시지 저장)
            await _dbRun(
                `UPDATE note_generation_jobs SET status='failed',error_msg=?,updated_at=datetime('now','localtime') WHERE id=?`,
                [err.message, job.id]
            );
        }
    } catch (err) { console.error('[JobWorker]', err.message); }

    setImmediate(processNextJob); // 이벤트 루프 양보 후 다음 작업
}

/**
 * 서버 재시작 시 processing 상태로 멈춘 작업을 pending으로 되돌려 재처리.
 * app.listen() 콜백에서 호출.
 */
async function recoverPendingJobs() {
    try {
        await _dbRun(`UPDATE note_generation_jobs SET status='pending' WHERE status='processing'`);
        const p = await _dbAll(`SELECT COUNT(*) as cnt FROM note_generation_jobs WHERE status='pending'`);
        if (p[0]?.cnt > 0) {
            console.log(`[JobWorker] ${p[0].cnt}개 미완료 작업 복구`);
            triggerWorker();
        }
    } catch (err) { console.warn('[JobWorker] 복구 실패:', err.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// [14] 학습 통계
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 마이페이지 상단 통계 바 데이터 반환.
 * Promise.all로 4개 쿼리를 동시 실행해 응답 시간 최소화.
 */
async function getNoteStats(userId) {
    const [noteCount, chatCount, feedbackAvg, recentFeedback] = await Promise.all([
        _dbGet(`SELECT COUNT(*) as cnt FROM notes WHERE user_id=?`, [userId]),
        _dbGet(`SELECT COUNT(*) as cnt FROM chat_logs WHERE user_id=?`, [userId]),
        _dbGet(`SELECT AVG(f.score) as avg_score FROM note_feedbacks f JOIN notes n ON n.id=f.note_id WHERE n.user_id=?`, [userId]),
        _dbAll(`SELECT f.score, f.created_at, n.title FROM note_feedbacks f JOIN notes n ON n.id=f.note_id WHERE n.user_id=? ORDER BY f.created_at DESC LIMIT 5`, [userId]),
    ]);
    return {
        noteCount      : noteCount?.cnt  || 0,
        chatCount      : chatCount?.cnt  || 0,
        avgScore       : Math.round(feedbackAvg?.avg_score || 0),
        recentFeedback : recentFeedback  || [],
        cacheStats     : noteCache.stats(),
        queueStats     : { semaphoreWaiting: aiSemaphore.waiting, circuitOpen: circuit.isOpen() },
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// Public API (index.js에서 require해서 사용)
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
    injectDb,         // DB 헬퍼 주입 (서버 시작 시 1회 호출)
    generateNote,     // AI 노트 생성
    generateFeedback, // AI 심층 피드백 생성
    enqueueJob,       // 비동기 작업 큐 등록
    getJobStatus,     // 작업 상태 조회
    getNoteStats,     // 학습 통계
    recoverPendingJobs, // 서버 시작 시 미완료 작업 복구
    noteCache,        // 캐시 직접 접근 (무효화 시 사용)
    rateLimiter,      // Rate Limiter 접근 (테스트용)
};