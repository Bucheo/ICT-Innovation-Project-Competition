@echo off
chcp 65001 > nul
title ICT Innovation Project

echo =================================
echo  서버 시작
echo  Express  : http://localhost:3000
echo  AI 서버  : http://localhost:8000
echo  종료     : 각 창을 닫거나 Ctrl+C
echo =================================
echo.

:: Python 찾기
set PYTHON_CMD=
for %%p in (python python3 py) do (
    if not defined PYTHON_CMD (
        %%p --version >nul 2>&1 && set PYTHON_CMD=%%p
    )
)

if not defined PYTHON_CMD (
    echo [ERROR] Python이 설치되어 있지 않습니다!
    echo  설치: https://www.python.org/downloads/
    echo  설치 시 "Add Python to PATH" 반드시 체크!
    pause
    exit /b 1
)

:: venv 없으면 생성
if not exist "venv" (
    echo [..] 가상환경 생성 중...
    %PYTHON_CMD% -m venv venv
)

:: venv 활성화
call venv\Scripts\activate.bat 2>nul
if errorlevel 1 (
    echo [WARN] 가상환경 활성화 실패, 전역 Python 사용
)

:: 패키지 설치 (stamp 파일로 중복 설치 방지)
if not exist "venv\.requirements-installed" (
    echo [..] Python 패키지 설치 중... (첫 실행 시 수 분 소요)
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] 패키지 설치 실패
        pause
        exit /b 1
    )
    echo. > venv\.requirements-installed
) else (
    echo [OK] Python 패키지 이미 설치됨
)

:: node_modules 없으면 설치
if not exist "node_modules" (
    echo [..] npm install 중...
    npm install
)

:: AI 서버 새 창으로 실행
echo [>>] AI 서버 시작...
start "AI Server (port 8000)" cmd /k "call venv\Scripts\activate.bat && python semantic_search.py"

:: 잠깐 대기 (AI 서버 초기화 시간)
timeout /t 3 /nobreak > nul

:: Express 서버 현재 창에서 실행
echo [>>] Express 서버 시작...
echo.
node index.js

pause