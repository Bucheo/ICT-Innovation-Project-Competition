@echo off
REM 🍑 Windows용 전체 서버 시작 스크립트

echo 🍑 전체 서버 시작 (Windows)
echo =================================

REM npm 패키지 설치
echo 🍑 Express 서버 패키지 설치 중...
call npm install

REM Python 패키지 설치
echo.
echo 🍑 AI 서버 패키지 설치 중...
pip install -r requirements.txt 2>nul || pip3 install -r requirements.txt

REM 서버 동시 실행
echo.
echo =================================
echo 🍑 서버 정보:
echo    Express 서버: http://localhost:3000
echo    AI 검색 서버: http://localhost:8000
echo    AI API 문서: http://localhost:8000/docs
echo.
echo 종료하려면 Ctrl+C를 누르세요.
echo =================================
echo.

REM concurrently로 두 서버 동시 실행
call npm run start:all

echo.
echo 🍑 모든 서버가 종료되었습니다.
pause