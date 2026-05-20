# ICT-Innovation-Project-Competition

# 🍑 ICT 혁신 프로젝트 경진대회 – AI 학습 플랫폼

> 3D 모델 기반 과학 학습 + 나만의 AI 노트 + 챗봇 피드백 시스템

---

## 📌 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [사용 기술 및 선택 이유](#3-사용-기술-및-선택-이유)
4. [AI 노트 시스템 설계](#4-ai-노트-시스템-설계)
5. [폴더 구조](#5-폴더-구조)
6. [설치 및 실행 방법](#6-설치-및-실행-방법)
7. [API 명세](#7-api-명세)
8. [데이터베이스 스키마](#8-데이터베이스-스키마)
9. [환경 변수](#9-환경-변수)
10. [트러블슈팅](#10-트러블슈팅)

---

## 1. 프로젝트 개요

중고등학생이 3D 모델을 보며 과학 개념을 학습하고, AI 챗봇에 질문하며, 자신만의 학습 노트를 AI와 함께 정리하는 플랫폼입니다.

### 주요 기능

| 기능 | 설명 |
|------|------|
| **3D 모델 탐색** | Sketchfab 임베드로 과학 개념 3D 시각화 |
| **AI 챗봇** | 과목별 학습 질문에 AI가 답변 (퀴즈 모드 지원) |
| **북마크** | 관심 있는 3D 모델 저장 |
| **AI 노트 만들기** | 북마크 + 챗봇 질문 기반 학습 노트 자동 생성 |
| **AI 심층 피드백** | 노트 품질 + 학습 패턴 5차원 분석 피드백 |
| **관리자/교사 페이지** | 모델 업로드, 사용자 관리 |

---

## 2. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                        클라이언트 (브라우저)                      │
│              HTML / CSS / Vanilla JS                         │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP (포트 3000)
┌───────────────────────────▼─────────────────────────────────┐
│                   Express.js 서버 (Node.js)                   │
│                                                               │
│   routes/aiNotes.js   →  aiNoteService.js                    │
│   index.js (챗봇 API)  →  callPythonChat() / callAnthropic() │
│                                                               │
│   ┌─────────────────┐    ┌──────────────────────────────┐   │
│   │  SQLite DB      │    │  대규모 트래픽 대응 레이어        │   │
│   │  data/app.db    │    │  LRU캐시 / Rate-limit /       │   │
│   └─────────────────┘    │  Semaphore / Circuit-Breaker  │   │
│                           │  / Job Queue                  │   │
│                           └──────────────────────────────┘   │
└──────────────┬────────────────────────┬────────────────────┘
               │ HTTP (포트 8000)        │ HTTPS
┌──────────────▼───────────┐  ┌─────────▼────────────────────┐
│  Python AI 서버           │  │  Anthropic API               │
│  (FastAPI + Uvicorn)     │  │  claude-sonnet (피드백 전용)   │
│                          │  │  claude-haiku  (챗봇 폴백)    │
│  · KoSimCSE (임베딩)      │  └──────────────────────────────┘
│  · FAISS (벡터 검색)      │
│  · Qwen 0.5B (챗봇)      │
└──────────────────────────┘
```

### 챗봇 요청 흐름
```
사용자 질문
    ↓
Python AI 서버 (Qwen 0.5B)
    ↓ 실패 (서버 꺼짐 / 5xx / 타임아웃)
Anthropic API (claude-haiku) ← 자동 폴백
    ↓ 실패
오류 메시지 반환
```

### 피드백 요청 흐름
```
피드백 버튼 클릭
    ↓
1시간 이내 캐시 확인 → (HIT) 즉시 반환
    ↓ (MISS)
DB 병렬 조회 (챗봇 이력 60개 + 노트 목록)
    ↓
analyzeNoteDepth()   → 노트 품질 등급(F~S) + 점수 상한
analyzeChatPattern() → 반복 키워드 + 약점 후보 + 관심 분야
    ↓
Anthropic API (claude-sonnet) — Chain-of-Thought 프롬프트
    ↓ 실패
Python AI (Qwen)
    ↓ 실패
로컬 fallback (규칙 기반 계산)
    ↓
점수 상한 강제 적용 → DB 저장 → 클라이언트 반환
```

---

## 3. 사용 기술 및 선택 이유

### Backend

#### Node.js + Express.js
- **선택 이유**: 비동기 I/O 처리에 특화. 다수의 사용자가 동시에 AI 요청을 보낼 때 이벤트 루프 기반으로 효율적으로 처리. 단일 스레드이지만 AI 호출·DB 쿼리 등 I/O 대기 시간을 블로킹하지 않아 대규모 트래픽에 적합.
- **역할**: REST API 서버, 인증, 파일 업로드, DB 연동, AI 서버 프록시

#### SQLite (sqlite3)
- **선택 이유**: 별도의 DB 서버 설치 없이 파일 하나(`data/app.db`)로 동작. 경진대회 특성상 배포·데모가 간편해야 하므로 선택. `?` 파라미터 방식으로 통일해 나중에 PostgreSQL 마이그레이션도 용이.
- **WAL 모드 미사용**: Windows에서 `-wal`, `-shm` 파일이 추가 생성되어 DB 복사 시 문제가 생기므로 기본 DELETE 모드 사용.

#### axios
- **선택 이유**: Python AI 서버(8000번)와 Anthropic API 양쪽에 동일한 라이브러리 사용. timeout, 에러 처리가 일관성 있게 관리됨.

#### bcryptjs
- **선택 이유**: 비밀번호 평문 저장 방지. salt+hash 방식으로 저장. bcrypt는 의도적으로 느리게 설계되어 무차별 대입 공격(brute-force)에 강함.

#### multer + sharp
- **선택 이유**: 3D 모델 썸네일 업로드(multer)와 WebP 변환·리사이징(sharp)을 파이프라인으로 연결해 이미지 최적화.

---

### Python AI 서버

#### FastAPI + Uvicorn
- **선택 이유**: Flask보다 비동기 처리 성능이 뛰어남. Pydantic 기반 요청 검증 자동화. `/docs`에서 Swagger UI 자동 생성으로 테스트 편리.
- **reload=False 이유**: Windows에서 `reload=True`는 멀티프로세스 방식이 필요한데, Node.js 자식 프로세스로 실행 시 즉시 종료되는 문제 발생.

#### Sentence Transformers (KoSimCSE)
- **선택 이유**: 한국어 문장 임베딩 특화 모델. "빛의 굴절" 검색 시 "광학 현상"이 담긴 모델도 찾아주는 **의미 기반 검색** 구현.
- **fallback**: 로드 실패 시 `all-MiniLM-L6-v2`(영어 범용)로 자동 전환.

#### FAISS (Facebook AI Similarity Search)
- **선택 이유**: 수백~수천 개 3D 모델 벡터 중 가장 유사한 것을 밀리초 단위 검색. SQL LIKE 검색보다 의미적 유사도 기반 검색 가능.
- **IndexFlatIP**: 코사인 유사도(벡터 정규화 후 내적) 방식. 작은 규모에서 정확도 최우선.

#### Qwen 2.5 0.5B Instruct
- **선택 이유**: GPU 없는 환경에서도 CPU로 로컬 실행 가능한 경량 LLM. 단순 학습 질문 답변에 충분한 성능.
- **한계**: 복잡한 JSON 구조화 지시를 따르지 못하는 경우가 있어, 피드백 생성은 Anthropic API를 우선 사용.

---

### AI 피드백 시스템

#### Anthropic API (Claude Sonnet / Haiku)
- **피드백에 Sonnet 사용**: 5차원 분석 + Chain-of-Thought + 엄격한 JSON 출력 규칙을 동시에 따르려면 지시 이행 능력이 높은 모델 필요.
- **챗봇 폴백에 Haiku 사용**: 단순 질문 답변에는 Haiku로 충분하고 응답이 빠르며 비용이 낮음.
- **System/User 프롬프트 분리**: AI가 역할(System)과 데이터(User)를 명확히 구분하도록 해 지시 이행률 향상.

#### Chain-of-Thought 프롬프트 기법
- **적용 이유**: 단순 "피드백 줘"보다, 노트 등급·챗봇 패턴·누락 개념을 수치화해 구조적으로 제공하면 AI가 단계적으로 추론하며 더 구체적인 피드백 생성.

---

### 대규모 트래픽 대응

#### LRU 캐시 (자체 구현)
- Redis 없이 인메모리 캐싱. 동일 북마크 조합 반복 요청 시 AI 호출 없이 즉시 반환. TTL 10분.

#### Rate Limiter (슬라이딩 윈도우)
- 사용자당 분당 5회 제한. 고정 윈도우 대비 경계 취약점 없음.

#### Semaphore
- AI 서버 동시 요청을 3개로 제한. 초과 요청은 대기열에서 순차 처리.

#### Circuit Breaker
- 연속 5회 실패 시 60초간 AI 서버 요청 차단. 장애 전파 방지 및 자동 복구.

#### DB 기반 Job Queue
- Rate Limit 초과 시 DB에 저장 후 처리. 서버 재시작 후에도 작업 유지.

---

## 4. AI 노트 시스템 설계

### 노트 품질 등급 시스템

| 등급 | 글자 수 | 설명 | 최대 점수 |
|------|---------|------|---------|
| F | ~19자 | 내용 없음 수준 | 15점 |
| D | 20~79자 | 단편적 메모 수준 | 30점 |
| C | 80~199자 | 기초 정리 수준 | 50점 |
| B | 200~499자 | 보통 학습 수준 | 75점 |
| A | 500~999자 | 충실한 정리 수준 | 90점 |
| S | 1000자~ | 심화 학습 수준 | 100점 |

### 피드백 5차원 출력

```json
{
  "score": 45,
  "grade": "C",
  "summary": "노트 분량이 150자(C등급)로 기초 수준입니다...",
  "concept_analysis": "세포분열 개념을 언급했으나 각 단계 설명이 없습니다...",
  "learning_pattern": "챗봇에 15회 질문 중 생명과학이 8회로...",
  "weak_areas": ["감수분열: 퀴즈 요청 3회, 노트에 미정리"],
  "interest_areas": ["생명과학", "세포생물학"],
  "strengths": ["핵심 키워드 위주로 간결하게 정리했습니다"],
  "improvements": ["세포분열 각 단계를 표로 정리해보세요"],
  "next_step": "지금 바로 '감수분열'의 4단계를 자신의 언어로..."
}
```

---

## 5. 폴더 구조

```
ICT-Innovation-Project-Competition/
│
├── index.js                 # Express 메인 서버
├── db.js                    # SQLite 연결 + 마이그레이션
├── aiNoteService.js         # AI 노트 핵심 서비스
├── semantic_search.py       # Python AI 서버 (FastAPI)
├── start-ai-server.js       # Python 서버 실행 스크립트
├── start-all.bat            # Windows 원클릭 실행
├── requirements.txt         # Python 패키지 목록
│
├── routes/
│   ├── aiNotes.js           # AI 노트 API (6개 엔드포인트)
│   ├── bookmarks.js         # 북마크 API
│   └── models_file.js       # 3D 모델 파일 API
│
├── sql/                     # DB 마이그레이션 (순서대로 실행)
│   ├── 001_init.sql
│   ├── 002_auth.sql
│   ├── 003_models.sql
│   ├── 004_bookmarks.sql
│   └── 005_ai_notes.sql     # AI 노트 관련 테이블
│
├── public/                  # 정적 파일
│   ├── intro.html           # 메인 (3D 모델 탐색)
│   ├── mypage.html          # 마이페이지 (노트 + 피드백)
│   ├── admin.html           # 관리자
│   ├── teacher.html         # 교사
│   ├── chatbot.js           # 챗봇 프론트엔드
│   └── chatbot.css
│
├── scripts/
│   ├── db-migrate.js        # 마이그레이션 실행
│   ├── make-admin.js        # 관리자 계정 생성
│   └── db-check.js          # DB 상태 확인
│
└── data/                    # 런타임 데이터
    ├── app.db               # SQLite DB
    ├── models.json          # 3D 모델 메타데이터
    └── categories.json
```

---

## 6. 설치 및 실행 방법

### 사전 요구사항

- **Node.js** 18 이상
- **Python** 3.9 이상 (PATH 등록 필수)
- **Anthropic API 키** (https://console.anthropic.com)

### Windows

```bash
# 1. 저장소 클론
git clone https://github.com/Sanduduck/ICT-Innovation-Project-Competition.git
cd ICT-Innovation-Project-Competition

# 2. 환경변수 설정
copy .env.example .env
# .env 파일을 메모장으로 열고 ANTHROPIC_API_KEY 입력

# 3. DB 초기화 (최초 1회)
node scripts/db-migrate.js

# 4. 원클릭 실행
start-all.bat
```

### Mac / Linux

```bash
# 1. 저장소 클론
git clone https://github.com/Sanduduck/ICT-Innovation-Project-Competition.git
cd ICT-Innovation-Project-Competition

# 2. Node.js 패키지 설치
npm install

# 3. Python 가상환경
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. 환경변수 설정
cp .env.example .env
# ANTHROPIC_API_KEY 입력

# 5. DB 초기화
node scripts/db-migrate.js

# 6. 서버 실행 (터미널 2개)
npm run ai    # AI 서버 (8000번)
npm start     # Express (3000번)
```

### 접속 URL

| 서비스 | URL |
|--------|-----|
| 메인 페이지 | http://localhost:3000 |
| 마이페이지 | http://localhost:3000/mypage.html |
| 관리자 | http://localhost:3000/admin |
| AI 서버 Swagger | http://localhost:8000/docs |

### 관리자 계정 생성

```bash
node scripts/make-admin.js
```

---

## 7. API 명세

### 인증
```
POST /api/auth/register    회원가입
POST /api/auth/login       로그인 (쿠키 발급)
POST /api/auth/logout      로그아웃
GET  /api/auth/whoami      현재 로그인 사용자 정보
```

### 챗봇
```
POST /api/chat
Body: { message: string, subject: string, withQuiz: boolean }
Response: { answer: string, model: string }
```

### AI 노트
```
POST /api/notes/generate           AI 노트 즉시 생성
POST /api/notes/generate/async     큐에 등록 후 jobId 반환
GET  /api/notes/jobs/:jobId        작업 상태 폴링
GET  /api/notes/stats              학습 통계
GET  /api/notes/feedback-history   피드백 이력
POST /api/notes/:id/feedback       AI 심층 피드백 생성
```

### 노트 CRUD
```
GET    /api/notes          목록
POST   /api/notes          생성
PUT    /api/notes/:id      수정
DELETE /api/notes/:id      삭제
```

---

## 8. 데이터베이스 스키마

```sql
-- 사용자
users (id, username, email, password, role, created_at)

-- 3D 모델
models (id, title, description, url, subject, thumb, created_at)

-- 북마크
bookmarks (id, user_id, model_id, created_at)

-- 학습 노트
notes (id, user_id, title, content, subject, updated_at, tags, created_at)

-- 챗봇 질문 로그
chat_logs (id, user_id, message, subject, with_quiz, created_at)

-- AI 피드백 (5차원 분석 결과)
note_feedbacks (
  id, note_id, user_id,
  feedback, summary, concept_analysis, learning_pattern, next_step,
  strengths, improvements, weak_areas, interest_areas,
  score, grade, created_at
)

-- 비동기 작업 큐
note_generation_jobs (
  id, user_id, model_ids,
  status,          -- pending / processing / done / failed
  result_note_id, error_msg, ai_used, priority,
  created_at, updated_at
)
```

---

## 9. 환경 변수

```env
# 필수: Anthropic API 키 (피드백 + 챗봇 폴백)
ANTHROPIC_API_KEY=sk-ant-api03-...

# 선택: Python AI 서버 주소 (기본값 사용 권장)
# AI_SERVER=http://127.0.0.1:8000

# 선택: Qwen 모델 변경
# CHAT_MODEL_NAME=Qwen/Qwen2.5-0.5B-Instruct
```

---

## 10. 트러블슈팅

| 오류 | 원인 | 해결 |
|------|------|------|
| `SQLITE_IOERR` | DB 파일 없음 또는 손상 | `node scripts/db-migrate.js` 실행 |
| `'pip'은 내부 명령어가 아닙니다` | pip이 PATH에 없음 | `python -m pip install -r requirements.txt` |
| `npm run ai exited with code 1` | `reload=True` Windows 충돌 | `semantic_search.py`에서 `reload=False`로 변경 |
| AI 피드백이 노트 내용 반복 | Qwen 소형 모델 한계 | `.env`에 `ANTHROPIC_API_KEY` 설정 |
| 챗봇 503 오류 | AI 서버 + Anthropic 모두 실패 | `npm run ai` 실행 후 API 키 확인 |

---

## 개발자

- **김준영** (팀장) – 백엔드, AI 서버, DB 설계
- ICT 혁신 프로젝트 경진대회 출품작

---

*최종 업데이트: 2026년 5월*