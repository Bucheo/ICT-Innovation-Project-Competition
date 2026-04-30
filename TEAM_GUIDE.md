# 🍑 팀 협업 가이드 (Mac + Windows)

## 📋 체크리스트

### Mac 사용자

```bash
# 1. 코드 받기
git pull

# 2. 패키지 설치
npm install

# 3. 서버 실행
npm run start:all

# 또는 bash 스크립트 사용
chmod +x start-all.sh
./start-all.sh
```

### Windows 사용자

```cmd
# 1. 코드 받기
git pull

# 2. 패키지 설치
npm install

# 3. 서버 실행
npm run start:all

# 또는 배치 파일 사용 (더블클릭 가능)
start-all.bat
```

## 🔧 설치 확인

```bash
# 모든 OS 공통
node test-setup.js
```

## 📦 필수 프로그램

### 모든 팀원 공통

1. **Node.js 14+** - [nodejs.org](https://nodejs.org)
2. **Python 3.8+** - [python.org](https://python.org)
    - ⚠️ Windows: 설치 시 "Add Python to PATH" 체크 필수!
3. **Git** - [git-scm.com](https://git-scm.com)

## 🚀 명령어 정리

| 작업      | 명령어                | 설명                        |
| --------- | --------------------- | --------------------------- |
| 전체 설치 | `npm run install:all` | Node + Python 패키지 설치   |
| 전체 실행 | `npm run start:all`   | Express + AI 서버 동시 실행 |
| Express만 | `npm start`           | 기본 검색만 (AI 없이)       |
| AI 서버만 | `npm run ai`          | AI 검색 서버만              |
| 개발 모드 | `npm run dev`         | nodemon으로 자동 재시작     |

## ⚠️ 자주 발생하는 문제

### 1. "python not found" (Windows)

- Python 설치 후 시스템 재시작
- 환경변수 PATH에 Python 추가 확인
- `python --version` 테스트

### 2. "pip not found"

```bash
# Windows
python -m pip install -r requirements.txt

# Mac/Linux
python3 -m pip install -r requirements.txt
```

### 3. AI 서버 연결 실패

- AI 서버 없어도 기본 검색은 작동함
- 포트 8000이 사용 중인지 확인
- Python 패키지 설치 확인: `pip list`

### 4. Git 줄 끝 문제 (CRLF/LF)

```bash
# 전역 설정 (권장)
git config --global core.autocrlf input  # Mac/Linux
git config --global core.autocrlf true   # Windows
```

## 🔍 검색 테스트

### 기본 검색 (Express만)

1. `npm start` 실행
2. http://localhost:3000 접속
3. "세포" 검색 → 제목/설명에 "세포" 포함된 결과만

### 하이브리드 검색 (Express + AI)

1. `npm run start:all` 실행
2. http://localhost:3000 접속
3. "세포" 검색 → "세포" + "DNA", "염색체" 등 관련 개념도 표시

## 📂 프로젝트 구조

```
park/
├── 🍑 semantic_search.py    # Python AI 서버
├── 🍑 requirements.txt      # Python 패키지 목록
├── 🍑 start-ai-server.js    # 크로스 플랫폼 AI 시작
├── 🍑 start-all.sh          # Mac/Linux 스크립트
├── 🍑 start-all.bat         # Windows 배치 파일
├── 🍑 test-setup.js         # 설치 확인
├── index.js                 # Express 서버 (🍑 수정됨)
├── package.json             # Node 패키지 (🍑 수정됨)
├── public/
│   └── index.html          # 프론트엔드 (🍑 수정됨)
└── data/
    └── models.json         # 3D 모델 데이터
```

## 💡 개발 팁

### VS Code 확장 추천

- **Python** - Microsoft
- **Prettier** - 코드 포맷팅
- **ESLint** - JavaScript 린팅
- **GitLens** - Git 히스토리

### 디버깅

```javascript
// 프론트엔드 (브라우저 콘솔)
console.log('🍑 AI 검색 결과:', aiResults);
console.log('🍑 병합 결과:', mergedMap);

// 백엔드 (터미널)
console.log('🍑 AI 서버 응답:', response.data);
```

### AI 서버 API 테스트

- http://localhost:8000/docs - Swagger UI
- http://localhost:8000/semantic_search?q=세포&k=10

## 🤝 협업 규칙

1. **커밋 메시지**: `feat:`, `fix:`, `docs:` 등 프리픽스 사용
2. **브랜치**: `feature/기능명` 형식
3. **PR 전 테스트**: `node test-setup.js` 실행
4. **🍑 표시**: 새로 추가한 코드에 표시 (선택사항)

## 📞 문제 발생 시

1. `node test-setup.js` 실행 결과 공유
2. 에러 메시지 전체 복사
3. OS 버전 명시 (Windows 10/11, macOS 버전 등)

---

_크로스 플랫폼 하이브리드 검색 시스템 v1.0_
