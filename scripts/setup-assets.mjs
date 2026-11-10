// MediaPipe WASM 파일을 public/으로 복사하고 포즈 모델(.task)을 내려받는다.
// 오프라인 동작(NFR-05)을 위해 모든 런타임 에셋을 앱 안에 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDir = path.join(root, 'public', 'models');

const MODELS = ['lite', 'full', 'heavy'].map((kind) => ({
  file: `pose_landmarker_${kind}.task`,
  url: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${kind}/float16/latest/pose_landmarker_${kind}.task`,
}));

function copyWasm() {
  if (!fs.existsSync(wasmSrc)) {
    console.warn('[setup] @mediapipe/tasks-vision 가 아직 설치되지 않아 WASM 복사를 건너뜁니다.');
    return;
  }
  fs.mkdirSync(wasmDst, { recursive: true });
  fs.cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('[setup] MediaPipe WASM 복사 완료');
}

async function downloadModels() {
  fs.mkdirSync(modelDir, { recursive: true });
  for (const m of MODELS) {
    const dst = path.join(modelDir, m.file);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) continue;
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dst, buf);
      console.log(`[setup] ${m.file} 다운로드 완료 (${(buf.length / 1e6).toFixed(1)} MB)`);
    } catch (err) {
      console.warn(`[setup] ${m.file} 다운로드 실패: ${err.message}. 나중에 'npm run setup:assets' 로 다시 시도하세요.`);
    }
  }
}

copyWasm();
await downloadModels();
