// routes/models_file.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

module.exports = function createModelsFileRouter() {
  const router = express.Router();

  // 경로 준비
  const DATA_DIR = path.join(__dirname, '..', 'data');
  const MODELS_JSON = path.join(DATA_DIR, 'models.json');
  const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

  // 폴더 보장
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // 파일 업로드(썸네일)
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      const base = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, '_').slice(0, 40);
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  });
  const upload = multer({ storage });

  // helpers
  function safeReadModels() {
    try {
      const raw = fs.readFileSync(MODELS_JSON, 'utf-8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  // 원자적 쓰기(임시파일 → rename)
  function safeWriteModels(arr) {
    const tmp = MODELS_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmp, MODELS_JSON);
  }

  function nextId(arr) {
    return (arr.reduce((m, x) => Math.max(m, x.id || 0), 0) || 0) + 1;
  }

  // (선택) 로그인 확인이 필요하면 여기에 붙이기
  // function requireLogin(req,res,next){ return req.cookies?.ac_auth ? next() : res.status(401).json({error:'Unauthorized'}); }

  // 목록 조회
  router.get('/', (req, res) => {
    const items = safeReadModels();
    res.json({ items });
  });

  // 생성(폼데이터 + 파일)  ※ 로그인 보호하려면 requireLogin 추가
  router.post('/', upload.single('thumb'), (req, res) => {
    const { title, description, url, subject } = req.body || {};
    if (!title || !description || !url) {
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    const items = safeReadModels();
    const id = nextId(items);
    const thumb = req.file ? `/uploads/${req.file.filename}` : null;

    const item = {
      id,
      title,
      description,
      url,
      subject: subject || '',
      thumb,
      created_at: new Date().toISOString().slice(0,19).replace('T',' ')
    };

    items.unshift(item);
    safeWriteModels(items);
    res.json({ item });
  });

  return router;
};
