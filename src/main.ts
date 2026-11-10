// 1단계: 자세 인식 프로토타입 + 성능 측정 화면.
// 카메라 선택 → MediaPipe Pose → 골격 오버레이 → 핸들 위치 지표 그래프, 출력 모니터 선택.

import './style.css';
import { loadConfig } from './config';
import { Camera, listCameras, savedCameraId } from './pose/camera';
import { HandleIndexTracker, type PoseMetrics } from './pose/handleIndex';
import type { Landmark } from './pose/landmarks';
import { PoseTracker, type Delegate, type ModelKind } from './pose/poseTracker';
import { PoseRecorder, downloadJson, timestampName } from './pose/recorder';
import { StressScene } from './bench/stressScene';
import { IndexGraph } from './ui/graph';
import { SkeletonOverlay, STATUS_COLOR } from './ui/overlay';
import { DurationStats, RateCounter, gradeFps } from './ui/stats';
import type { DisplayInfo } from './types/wakeline';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- 로컬 설정 ----------
const pref = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(`wakeline.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`wakeline.${key}`, value);
    } catch {
      /* 무시 */
    }
  },
};

async function main() {
  const config = await loadConfig();
  const det = config.detection;

  const video = $<HTMLVideoElement>('video');
  const stage = $<HTMLElement>('stage');
  const camWrap = $<HTMLDivElement>('camWrap');
  const badge = $<HTMLDivElement>('badge');
  const camSelect = $<HTMLSelectElement>('camSelect');
  const resSelect = $<HTMLSelectElement>('resSelect');
  const modelSelect = $<HTMLSelectElement>('modelSelect');
  const delegateSelect = $<HTMLSelectElement>('delegateSelect');
  const stressToggle = $<HTMLInputElement>('stressToggle');
  const modelStatus = $<HTMLDivElement>('modelStatus');
  const recBtn = $<HTMLButtonElement>('recBtn');
  const recStatus = $<HTMLSpanElement>('recStatus');

  const camera = new Camera(video);
  const tracker = new PoseTracker();
  const handle = new HandleIndexTracker(det);
  const overlay = new SkeletonOverlay($<HTMLCanvasElement>('overlay'));
  const graph = new IndexGraph($<HTMLCanvasElement>('graph'), 10000, det.catchThreshold, det.finishThreshold);
  const recorder = new PoseRecorder();
  let stress: StressScene | null = null;

  const camRate = new RateCounter();
  const poseRate = new RateCounter();
  const renderRate = new RateCounter();
  const infer = new DurationStats();

  let latestLms: Landmark[] | null = null;
  let latestMetrics: PoseMetrics | null = null;
  let modelBusy = false;
  let camSize = { width: 640, height: 480 };
  let cameraOn = true;
  let vfcHandle: number | null = null;

  // ---------- 모델 ----------
  modelSelect.value = pref.get('model', 'full');
  delegateSelect.value = pref.get('delegate', 'GPU');

  async function initModel() {
    modelBusy = true;
    const model = modelSelect.value as ModelKind;
    const delegate = delegateSelect.value as Delegate;
    modelStatus.className = 'hint';
    modelStatus.textContent = `${model} 모델을 ${delegate}에서 불러오는 중…`;
    try {
      const used = await tracker.init(model, delegate);
      delegateSelect.value = used;
      pref.set('model', model);
      pref.set('delegate', used);
      modelStatus.textContent =
        used === delegate ? `${model} · ${used} 사용 중` : `GPU를 쓸 수 없어 CPU로 실행 중입니다.`;
      infer.reset();
      handle.reset();
    } catch (err) {
      console.error(err);
      modelStatus.className = 'hint error';
      modelStatus.textContent = `모델 로딩 실패: ${(err as Error).message}`;
    } finally {
      modelBusy = false;
    }
  }

  modelSelect.addEventListener('change', initModel);
  delegateSelect.addEventListener('change', initModel);

  // ---------- 카메라 ----------
  resSelect.value = pref.get('res', '1280x720');

  async function startCamera(deviceId: string | null) {
    const [w, h] = resSelect.value.split('x').map(Number);
    badge.className = 'badge none';
    badge.textContent = '카메라 연결 중';
    try {
      const info = await camera.start(deviceId, w, h);
      armFrameLoop();
      camSize = { width: info.width, height: info.height };
      camWrap.style.aspectRatio = `${info.width} / ${info.height}`;
      $('sRes').textContent = `${info.width}×${info.height}`;
      pref.set('res', resSelect.value);
      handle.reset();
    } catch (err) {
      console.error(err);
      badge.textContent = `카메라 오류: ${(err as Error).message}`;
    }
  }

  async function refreshCameraList() {
    const cams = await listCameras();
    const current = video.srcObject instanceof MediaStream
      ? video.srcObject.getVideoTracks()[0]?.getSettings().deviceId
      : savedCameraId();
    camSelect.innerHTML = '';
    for (const c of cams) {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label;
      camSelect.appendChild(opt);
    }
    if (current && cams.some((c) => c.deviceId === current)) camSelect.value = current;
    if (!cams.length) {
      const opt = document.createElement('option');
      opt.textContent = '카메라 없음';
      camSelect.appendChild(opt);
    }
  }

  // ---------- 카메라 켜기/끄기 ----------
  // 끄면 스트림을 완전히 멈춰 카메라 표시등도 꺼지고, 자세 인식도 쉰다.
  const camToggle = $<HTMLButtonElement>('camToggle');
  let toggling = false;

  async function setCameraOn(on: boolean) {
    if (toggling) return;
    toggling = true;
    cameraOn = on;
    camToggle.textContent = on ? '카메라 끄기' : '카메라 켜기';
    camToggle.classList.toggle('on', on);
    camToggle.classList.toggle('off', !on);
    camToggle.setAttribute('aria-pressed', String(on));
    camWrap.classList.toggle('off', !on);
    try {
      if (on) {
        await startCamera(camSelect.value || savedCameraId());
      } else {
        if (vfcHandle !== null) video.cancelVideoFrameCallback(vfcHandle);
        vfcHandle = null;
        camera.stop();
        latestLms = null;
        latestMetrics = null;
        handle.reset();
        badge.className = 'badge off';
        badge.textContent = '카메라 꺼짐';
        $('sRes').textContent = '-';
      }
    } finally {
      toggling = false;
    }
  }

  camToggle.addEventListener('click', () => setCameraOn(!cameraOn));
  window.addEventListener('keydown', (e) => {
    // 한글 입력 상태에서도 동작하도록 e.code로 판별
    if (e.code !== 'KeyC' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    setCameraOn(!cameraOn);
  });

  // 꺼진 상태에서 장치/해상도를 바꾸면 바로 켠다.
  camSelect.addEventListener('change', () => (cameraOn ? startCamera(camSelect.value) : setCameraOn(true)));
  resSelect.addEventListener('change', () =>
    cameraOn ? startCamera(camSelect.value || savedCameraId()) : setCameraOn(true),
  );
  navigator.mediaDevices.addEventListener('devicechange', refreshCameraList);

  // ---------- 프레임마다 자세 인식 ----------
  function onVideoFrame() {
    const now = performance.now();
    camRate.tick(now);
    if (tracker.ready && !modelBusy && video.readyState >= 2) {
      const { landmarks, inferenceMs } = tracker.detect(video);
      poseRate.tick(now);
      infer.push(inferenceMs);
      latestLms = landmarks;
      latestMetrics = handle.update(landmarks, camSize.width / camSize.height, now);
      graph.push({ t: now, index: latestMetrics.index, knee: latestMetrics.kneeAngleDeg });
      recorder.push(now, landmarks);
    }
    vfcHandle = video.requestVideoFrameCallback(onVideoFrame);
  }

  /** 카메라를 (다시) 켤 때마다 프레임 루프를 하나만 걸어둔다. */
  function armFrameLoop() {
    if (vfcHandle !== null) video.cancelVideoFrameCallback(vfcHandle);
    vfcHandle = video.requestVideoFrameCallback(onVideoFrame);
  }

  // ---------- 화면 갱신 ----------
  let lastStats = 0;
  const STATUS_TEXT = { ok: '정상 인식', partial: '일부 관절 가려짐', none: '사람 없음' } as const;

  function renderLoop() {
    const now = performance.now();
    renderRate.tick(now);
    stress?.render();

    const status = latestMetrics?.status ?? 'none';
    const side = latestMetrics?.side ?? 'left';
    if (cameraOn) overlay.draw(latestLms, status, side, det.minVisibility);
    else overlay.clear();
    graph.draw(now);

    if (now - lastStats > 250) {
      lastStats = now;
      if (cameraOn && video.srcObject) {
        badge.className = `badge ${status}`;
        badge.textContent = STATUS_TEXT[status];
      }
      const m = latestMetrics;
      $('mIndex').textContent = m?.index != null ? m.index.toFixed(2) : '-';
      $('mKnee').textContent = m?.kneeAngleDeg != null ? `${Math.round(m.kneeAngleDeg)}°` : '-';
      $('mSide').textContent = m ? (m.side === 'left' ? '왼쪽' : '오른쪽') : '-';
      $('mIndex').style.color = STATUS_COLOR[status];

      setStat('sCam', camRate.rate(now), 25, 'fps');
      setStat('sPose', poseRate.rate(now), 25, 'fps');
      setStat('sRender', renderRate.rate(now), 50, 'fps');
      setMs('sInfer', infer.mean);
      setMs('sInfer95', infer.p95);

      if (recorder.recording) {
        recStatus.textContent = `${(recorder.durationMs / 1000).toFixed(0)}초 · ${recorder.frameCount}프레임`;
      }
    }
    requestAnimationFrame(renderLoop);
  }

  function setStat(id: string, fps: number, target: number, unit: string) {
    const el = $(id);
    el.textContent = `${fps.toFixed(0)} ${unit}`;
    el.className = `v ${gradeFps(fps, target)}`;
  }

  function setMs(id: string, ms: number) {
    const el = $(id);
    el.textContent = `${ms.toFixed(1)} ms`;
    // 30fps 예산(33ms) 안에 다른 작업까지 들어가야 하므로 20ms 이하를 양호로 본다.
    el.className = `v ${ms <= 20 ? 'good' : ms <= 33 ? 'warn' : 'bad'}`;
  }

  // ---------- 3D 부하 ----------
  function setStress(on: boolean) {
    const sceneCanvas = $<HTMLCanvasElement>('scene');
    sceneCanvas.hidden = !on;
    stage.classList.toggle('game-layout', on);
    if (on && !stress) stress = new StressScene(sceneCanvas);
    if (!on && stress) {
      stress.dispose();
      stress = null;
    }
    pref.set('stress', on ? '1' : '0');
  }
  stressToggle.checked = pref.get('stress', '0') === '1';
  stressToggle.addEventListener('change', () => setStress(stressToggle.checked));
  setStress(stressToggle.checked);

  // ---------- 좌표 녹화 ----------
  recBtn.addEventListener('click', () => {
    if (!recorder.recording) {
      recorder.start(camSize.width, camSize.height, `${tracker.model}/${tracker.delegate}`);
      recBtn.textContent = '녹화 중지 · 저장';
      recBtn.classList.add('recording');
    } else {
      const data = recorder.stop();
      recBtn.textContent = '녹화 시작';
      recBtn.classList.remove('recording');
      recStatus.textContent = `${data.frames.length}프레임 저장`;
      downloadJson(data, timestampName('wakeline-pose'));
    }
  });

  // ---------- 출력 모니터 ----------
  setupDisplayControls();

  // ---------- 시작 ----------
  renderLoop();
  await Promise.all([initModel(), startCamera(savedCameraId())]);
  await refreshCameraList();
}

function setupDisplayControls() {
  const displaySelect = $<HTMLSelectElement>('displaySelect');
  const moveBtn = $<HTMLButtonElement>('moveBtn');
  const fsBtn = $<HTMLButtonElement>('fsBtn');
  const hint = $<HTMLParagraphElement>('displayHint');
  const api = window.wakeline;

  if (!api) {
    // 브라우저 모드: 모니터 선택은 창을 끌어서 옮기고 전체화면만 제공
    displaySelect.closest('label')!.hidden = true;
    moveBtn.hidden = true;
    hint.textContent = '브라우저 모드: 창을 원하는 모니터로 끌어 옮긴 뒤 전체화면을 누르세요.';
    const sync = () => (fsBtn.textContent = document.fullscreenElement ? '창 모드' : '전체화면');
    fsBtn.addEventListener('click', async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', sync);
    return;
  }

  let fullscreen = false;
  const fill = (displays: DisplayInfo[]) => {
    const keep = displaySelect.value;
    displaySelect.innerHTML = '';
    displays.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      const tags = [d.primary ? '주 모니터' : '', d.current ? '현재' : ''].filter(Boolean).join(', ');
      opt.textContent = `${i + 1}. ${d.label} (${d.width}×${d.height})${tags ? ` · ${tags}` : ''}`;
      displaySelect.appendChild(opt);
    });
    const current = displays.find((d) => d.current);
    if (keep && displays.some((d) => String(d.id) === keep)) displaySelect.value = keep;
    else if (current) displaySelect.value = String(current.id);
  };
  const syncFs = (on: boolean) => {
    fullscreen = on;
    fsBtn.textContent = on ? '창 모드' : '전체화면';
  };

  api.listDisplays().then(fill);
  api.getWindowState().then((s) => s && syncFs(s.fullscreen));
  api.onDisplaysChanged(fill);
  api.onWindowState(async (s) => {
    syncFs(s.fullscreen);
    fill(await api.listDisplays());
  });

  moveBtn.addEventListener('click', async () => {
    // 다른 모니터(프로젝터)로 보낼 때는 바로 전체화면으로 띄운다.
    await api.moveToDisplay(Number(displaySelect.value), true);
  });
  fsBtn.addEventListener('click', () => api.setFullscreen(!fullscreen));
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#ff5c5c;padding:16px">${String(err)}</pre>`);
});
