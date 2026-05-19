#!/usr/bin/env node
/**
 * AI 서버 시작 스크립트 (크로스 플랫폼)
 * Windows, Mac, Linux 모두 지원
 *
 * 수정: pip/pip3 직접 호출 → "python -m pip" 사용
 * → Windows에서 pip이 PATH에 없어도 정상 동작
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

console.log('AI 의미 검색 서버 시작 준비...');
console.log('=================================');

/* ── Python 실행 파일 탐색 ─────────────────────────────────── */
function getPythonCommand() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe' });
      console.log(`[OK] Python 찾음: ${cmd}`);
      return cmd;
    } catch (_) { /* 다음 시도 */ }
  }
  return null;
}

/* ── pip 사용 가능 여부 확인 ────────────────────────────────── */
function checkPip(pythonCmd) {
  try {
    execSync(`${pythonCmd} -m pip --version`, { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/* ── 패키지 설치 (python -m pip 방식) ──────────────────────── */
function installPackages(pythonCmd, scriptPath) {
  console.log('[..] 필요한 패키지 설치 중...');
  console.log('     (첫 실행 시 몇 분 소요될 수 있습니다)');

  if (!checkPip(pythonCmd)) {
    console.error('[ERR] pip 모듈을 찾을 수 없습니다.');
    console.error('      아래 명령어로 pip을 먼저 설치해주세요:');
    console.error(`      ${pythonCmd} -m ensurepip --upgrade`);
    process.exit(1);
  }

  // shell:false → "pip은 내부 명령어가 아닙니다" 오류 방지
  const proc = spawn(
    pythonCmd,
    ['-m', 'pip', 'install', '-r', 'requirements.txt'],
    {
      stdio: 'inherit',
      shell: false,
      env  : { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }
  );

  proc.on('error', (err) => {
    console.error('[ERR] 패키지 설치 실패:', err.message);
    process.exit(1);
  });

  proc.on('close', (code) => {
    if (code === 0) {
      runServer(pythonCmd, scriptPath);
    } else {
      console.error(`[ERR] pip install 실패 (코드: ${code})`);
      console.error('      수동 설치 명령어:');
      console.error(`      ${pythonCmd} -m pip install fastapi uvicorn sentence-transformers faiss-cpu numpy torch transformers`);
      process.exit(1);
    }
  });
}

/* ── Python AI 서버 실행 ────────────────────────────────────── */
function runServer(pythonCmd, scriptPath) {
  console.log('');
  console.log('[>>] AI 서버 시작...');
  console.log('=================================');
  console.log('  주소    : http://localhost:8000');
  console.log('  API 문서: http://localhost:8000/docs');
  console.log('  종료    : Ctrl+C');
  console.log('=================================');

  const server = spawn(pythonCmd, [scriptPath], {
    stdio: 'inherit',
    shell: false,
    env  : { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  server.on('error', (err) => {
    console.error('[ERR] 서버 시작 실패:', err.message);
    process.exit(1);
  });

  server.on('close', (code) => {
    console.log(`[--] AI 서버 종료 (코드: ${code})`);
    process.exit(code);
  });

  process.on('SIGINT', () => {
    console.log('\n[--] 서버 종료 중...');
    server.kill('SIGINT');
  });
}

/* ── 메인 ───────────────────────────────────────────────────── */
function main() {
  const pythonCmd = getPythonCommand();

  if (!pythonCmd) {
    console.error('[ERR] Python이 설치되어 있지 않습니다!');
    console.error('  Windows: https://www.python.org/downloads/');
    console.error('           설치 시 "Add Python to PATH" 반드시 체크!');
    process.exit(1);
  }

  const scriptPath = path.join(__dirname, 'semantic_search.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[ERR] semantic_search.py 를 찾을 수 없습니다!');
    process.exit(1);
  }

  installPackages(pythonCmd, scriptPath);
}

main();