#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🍑 AI 의미 기반 검색 서버
KoSimCSE 모델을 사용한 한국어 임베딩 검색
"""

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

# CORS 미들웨어 임포트
from fastapi.middleware.cors import CORSMiddleware 
'''
CORS를 켜기 위한 미들웨어입니다. 
CORS는 “다른 도메인·포트에서 오는 요청을 허용할지 말지”를 정하는 웹 규칙
브라우저는 이걸 안 해주면 JS로 API를 못 부름
'''

from sentence_transformers import SentenceTransformer
from transformers import AutoModelForCausalLM, AutoTokenizer
import faiss
import numpy as np
import json
import uvicorn
import os
import torch
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

app = FastAPI() # FastAPI 서버 인스턴스를 하나 만듭니다.

# 🍑 CORS 설정 - Express 서버와 통신 허용

'''이 코드는 “이 파이썬 서버(8000번)에 다른 포트(3000번, 3001번)에서 오는 요청을 허용해라”는 설정
    웹브라우저가 기본적으로 막는 걸 열어주는 거다. CORS 설정이라고 부른다
'''
app.add_middleware( 
#   app.add_middleware(CORSMiddleware, ...)
#   FastAPI 앱에 “미들웨어”를 하나 끼워 넣는다는 뜻이다.
#   이 미들웨어는 들어오는 요청마다 CORS 관련 헤더를 붙여준다.
#   안 붙이면 브라우저가 “다른 포트에서 온 요청이니까 위험해” 하고 막는다.

    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],

#   allow_origins=["http://localhost:3000", "http://localhost:3001", "*"]
#   origin은 “어디서 이 API를 부르냐”이다. 주소+포트까지 포함이다.
#   http://localhost:3000 ← React/Node 프런트 개발서버
#   예: http://localhost:3001 ← 또 다른 프런트
#   여기서 가장 중요한 건 3000이다. 왜냐하면 너의 Express/React가 3000에서 돌고, 
#  이 파이썬은 8000에서 도니까 “포트가 다르다.” 포트가 다르면 브라우저는 CORS를 검사한다
#  그래서 3000, 3001에서 오는 요청은 허용해~~~ 라는 건데, 우린 *도 넣었는데 "*"은 걍 다 허용하라는거임, 이건 그냥 개발 편의를 위한 거니까 나중에 운영할 때는 빼는 게 좋음
    allow_credentials=True, #“쿠키, Authorization 헤더 같은 인증 정보도 보내도 된다”는 뜻이다.
    allow_methods=["*"], # “모든 HTTP 메서드(GET, POST, PUT, DELETE 등)를 허용한다”는 뜻
    allow_headers=["*"], # “모든 헤더를 허용한다”는 뜻, Content-Type: application/json, Authorization: Bearer ... 이런 것도 다 허용.
)

# 🍑 데이터 및 모델 초기화, models.json(검색 대상) 읽기
print("🍑 모델 로딩 중...")

# models.json 경로 - data 폴더와 public 폴더 둘 다 체크
MODEL_PATH = None
for path in ["data/models.json", "public/models.json"]:
    if os.path.exists(path):
        MODEL_PATH = path
        break

if not MODEL_PATH:
    print("⚠️ models.json 파일을 찾을 수 없습니다!")
    MODELS = []
else:
    with open(MODEL_PATH, "r", encoding="utf-8") as f:
        MODELS = json.load(f)
    print(f"🍑 {len(MODELS)}개 모델 로드 완료")

# 🍑 임베딩 모델 초기화 (한국어 특화 모델), “AI가 문장을 숫자로 바꾸는 모델(임베딩 모델)”을 불러오는 부분
try:
    # 한국어 지원 모델들 시도
    model_name = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"  # 다국어 모델
    embed_model = SentenceTransformer(model_name)

    '''
    SentenceTransformer(...)는 Hugging Face Hub에서 미리 학습된 모델을 자동 다운로드한다.
    이 모델은 “다국어 문장 임베딩 모델”로, 영어뿐 아니라 한국어·중국어 등 약 50개 언어를 지원한다.  
    ‘문장 → 벡터’로 변환해 주므로,
    “로봇 팔 제어”와 “로봇 제어 방법” 같은 비슷한 문장이 벡터 공간에서 가까이 위치한다.
    그래서 단순 단어 검색이 아니라 의미가 비슷한 문장 검색이 가능해진다.
    '''
    print(f"🍑 다국어 모델 로드 완료: {model_name}")

except Exception as e:
    print(f"⚠️ 모델 로딩 실패: {e}")
    # 기본 모델로 폴백
    embed_model = SentenceTransformer("all-MiniLM-L6-v2")
    print("🍑 기본 영어 모델로 대체 로드")

# 🍑 문서 임베딩 생성 (title + description)
if MODELS: 
    """
    앞에서 models.json을 못 읽었으면 MODELS = []였다.
    빈 리스트면 임베딩 만들 필요가 없으니 바로 index = None으로 두고 끝낸다.
    즉 “검색할 데이터가 있을 때만” 임베딩과 FAISS를 만든다.
    """
    doc_texts = []
    for m in MODELS:
        title = m.get("title", "")
        description = m.get("description", "")
        # 과목 정보도 포함하면 더 정확한 검색 가능
        subject = m.get("subject", "")
        combined = f"{title} {description} {subject}"
        doc_texts.append(combined)

    print("🍑 문서 임베딩 생성 중...")
    doc_embeddings = embed_model.encode(doc_texts, show_progress_bar=True)

    # 🍑 FAISS 인덱스 생성 (코사인 유사도)
    dimension = doc_embeddings.shape[1]
    index = faiss.IndexFlatIP(dimension)  # Inner Product = Cosine similarity (정규화된 벡터)

    # L2 정규화로 코사인 유사도 계산 준비
    faiss.normalize_L2(doc_embeddings)
    index.add(doc_embeddings.astype('float32'))
    print(f"🍑 FAISS 인덱스 생성 완료 (차원: {dimension})")
    # 이 부분 어려울 수도 있는데 코사인 유사도 거리는 걍 의미가 가까운지 먼지 재는 방법 중 하나라고 생각하면 됨
else:
    index = None
    doc_embeddings = None

@app.get("/")
def root():
    """🍑 서버 상태 확인"""
    return {
        "status": "running",
        "message": "🍑 AI 의미 검색 서버 실행 중",
        "models_count": len(MODELS),
        "model_name": "paraphrase-multilingual-mpnet-base-v2"
    }

@app.get("/semantic_search")
def semantic_search(
    q: str = Query(..., description="검색 쿼리"),
    k: int = Query(20, description="반환할 결과 개수", ge=1, le=20)
):
    """
    🍑 의미 기반 검색 API

    Args:
        q: 검색어
        k: 반환할 결과 수 (최대 le = 20)

    Returns:
        검색 결과 (id, title, description, score)
    """

    if not index or not MODELS:
        return {"error": "인덱스가 초기화되지 않았습니다", "results": []}

    # 🍑 쿼리 임베딩 생성
    query_embedding = embed_model.encode([q])
    faiss.normalize_L2(query_embedding)

    # 🍑 유사도 검색 수행
    k = min(k, len(MODELS))  # k가 전체 문서 수보다 크면 조정
    distances, indices = index.search(query_embedding.astype('float32'), k)

    # 🍑 결과 포맷팅
    results = []
    for score, idx in zip(distances[0], indices[0]):
        # 🍑 Score 0.3 이상만 필터링 (30% 이상 유사도)
        if idx < len(MODELS) and score >= 0.25:  # 인덱스 범위 체크 + score 필터링
            item = MODELS[idx]
            results.append({
                "id": item.get("id", idx),
                "title": item.get("title", ""),
                "description": item.get("description", ""),
                "subject": item.get("subject", ""),
                "score": float(score),  # 코사인 유사도 (0~1)
                "rank": len(results) + 1
            })

    return {
        "query": q,
        "count": len(results),
        "results": results,
        "method": "semantic_search",
        "model": "multilingual-mpnet"
    }

CHAT_MODEL_NAME = os.getenv("CHAT_MODEL_NAME", "Qwen/Qwen2.5-0.5B-Instruct")
chat_tokenizer = None
chat_model = None
chat_device = "cuda" if torch.cuda.is_available() else "cpu"

SUBJECT_LABELS = {
    "biology": "생명과학",
    "physics": "물리학",
    "chemistry": "화학",
    "earth": "지구과학",
    "geography": "지리학",
}


class ChatRequest(BaseModel):
    message: str
    subject: str = ""
    with_quiz: bool = False


def load_chat_model():
    """Load Qwen lazily so semantic search can start quickly."""
    global chat_tokenizer, chat_model

    if chat_tokenizer is not None and chat_model is not None:
        return chat_tokenizer, chat_model

    print(f"챗봇 모델 로딩 중: {CHAT_MODEL_NAME}")
    chat_tokenizer = AutoTokenizer.from_pretrained(
        CHAT_MODEL_NAME,
        trust_remote_code=True,
    )
    dtype = torch.float16 if chat_device == "cuda" else torch.float32
    chat_model = AutoModelForCausalLM.from_pretrained(
        CHAT_MODEL_NAME,
        torch_dtype=dtype,
        trust_remote_code=True,
    )
    chat_model.to(chat_device)
    chat_model.eval()
    print(f"챗봇 모델 로딩 완료: {CHAT_MODEL_NAME} ({chat_device})")
    return chat_tokenizer, chat_model


def build_chat_messages(req: ChatRequest):
    subject_label = SUBJECT_LABELS.get(req.subject, "일반")
    system_prompt = (
        "너는 중고등학생을 돕는 한국어 학습 도우미야. "
        "답변은 정확하고 친절하게 하되, 너무 길지 않게 핵심부터 설명해. "
        "학생이 외우기보다 이해할 수 있도록 예시를 들어줘. "
        f"현재 과목은 {subject_label}이야."
    )

    user_message = req.message
    if req.with_quiz:
        user_message = (
            f"{req.message}\n\n"
            "퀴즈 형식으로 답할 때는 객관식 또는 단답형 3문제와 정답, 짧은 해설을 포함해줘."
        )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]


@app.post("/chat")
def chat(req: ChatRequest):
    if not req.message.strip():
        return {"error": "메시지를 입력해주세요", "answer": ""}

    try:
        tokenizer, model = load_chat_model()
        messages = build_chat_messages(req)
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        inputs = tokenizer([prompt], return_tensors="pt").to(chat_device)

        with torch.no_grad():
            generated = model.generate(
                **inputs,
                max_new_tokens=512,
                temperature=0.7,
                top_p=0.9,
                do_sample=True,
                repetition_penalty=1.08,
                pad_token_id=tokenizer.eos_token_id,
            )

        output_ids = generated[0][inputs.input_ids.shape[-1]:]
        answer = tokenizer.decode(output_ids, skip_special_tokens=True).strip()
        return {
            "answer": answer,
            "model": CHAT_MODEL_NAME,
            "subject": req.subject,
        }
    except Exception as e:
        print(f"챗봇 생성 오류: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health_check():
    """🍑 헬스체크 엔드포인트"""
    return {
        "status": "healthy",
        "models_loaded": len(MODELS),
        "chat_model": CHAT_MODEL_NAME,
        "chat_loaded": chat_model is not None,
    }

if __name__ == "__main__":
    # 🍑 서버 실행 (포트 8000)
    print("🍑 AI 의미 검색 서버 시작: http://localhost:8000")
    print("🍑 API 문서: http://localhost:8000/docs")
    uvicorn.run("semantic_search:app", host="0.0.0.0", port=8000, reload=True)
