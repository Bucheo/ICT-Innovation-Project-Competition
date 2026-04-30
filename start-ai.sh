#!/bin/bash
# 🍑 AI 의미 검색 서버 시작 스크립트

echo "🍑 AI 의미 검색 서버 시작 스크립트"
echo "================================="

# Python 체크
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3가 설치되어 있지 않습니다."
    echo "   brew install python3 (Mac) 또는"
    echo "   apt install python3 (Ubuntu) 실행 후 다시 시도하세요."
    exit 1
fi

# 가상환경 생성 (없으면)
if [ ! -d "venv" ]; then
    echo "🍑 Python 가상환경 생성 중..."
    python3 -m venv venv
fi

# 가상환경 활성화
echo "🍑 가상환경 활성화..."
source venv/bin/activate

# 패키지 설치
echo "🍑 필요한 패키지 설치 중..."
pip install -r requirements.txt

# AI 서버 실행
echo ""
echo "🍑 AI 의미 검색 서버 시작..."
echo "   주소: http://localhost:8000"
echo "   문서: http://localhost:8000/docs"
echo ""
echo "종료하려면 Ctrl+C를 누르세요."
echo "================================="
python semantic_search.py