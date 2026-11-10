// 1단계: 자세 인식 프로토타입 + 성능 측정 화면.
// 카메라 선택 → MediaPipe Pose → 골격 오버레이 → 핸들 위치 지표 그래프, 출력 모니터 선택.

import './style.css';
import { loadConfig, loadMap, type DifficultyId } from './config';
import type { OpponentKind } from './game/race';
import { formatTime } from './game/race';
import { RaceScreen } from './ui/raceScreen';
import { Camera, listCameras, savedCameraId } from './pose/camera';
import { HandleIndexTracker, type PoseMetrics } from './pose/handleIndex';
import type { Landmark } from './pose/landmarks';
import { PoseTracker, type Delegate, type ModelKind } from './pose/poseTracker';
import { PoseRecorder, downloadJson, timestampName } from './pose/recorder';
import { StressScene } from './bench/stressScene';
import { CameraCheck } from './check/cameraCheck';
import { CheckView } from './ui/checkView';
import { IndexGraph } from './ui/graph';
import { SkeletonOverlay, STATUS_COLOR } from './ui/overlay';
import { DurationStats, RateCounter, gradeFps } from './ui/stats';
import type { CaptureSource, DisplayInfo } from './types/wakeline';

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
  const hanRiver = await loadMap('han-river');
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
  const check = new CameraCheck(det);
  const checkView = new CheckView($<HTMLElement>('checkPanel'));
  let checkMode = false;
  let brightness: number | null = null;
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

  // ---------- 영상 입력 (카메라 / 동영상 파일 / 화면 캡처) ----------
  resSelect.value = pref.get('res', '1280x720');

  const FILE_PICK = '__file_pick__';
  const FILE_LOADED = '__file_loaded__';
  const CAPTURE_PICK = '__capture_pick__';
  const CAPTURE_ACTIVE = '__capture_active__';
  const fileInput = $<HTMLInputElement>('fileInput');
  const fileControls = $<HTMLDivElement>('fileControls');
  const playBtn = $<HTMLButtonElement>('playBtn');
  const seekBar = $<HTMLInputElement>('seekBar');
  const timeLabel = $<HTMLSpanElement>('timeLabel');
  const speedSelect = $<HTMLSelectElement>('speedSelect');
  const camToggle = $<HTMLButtonElement>('camToggle');

  let mode: 'camera' | 'file' | 'capture' = 'camera';
  let currentFile: File | null = null;
  let captureSourceId: string | null = null;
  let captureName: string | null = null;
  const SOURCE_WORD = { camera: '카메라', file: '영상', capture: '캡처' } as const;
  let cameraId: string | null = savedCameraId();
  let cameraList: { deviceId: string; label: string }[] = [];

  function applySourceInfo(info: { width: number; height: number }) {
    armFrameLoop();
    camSize = { width: info.width, height: info.height };
    camWrap.style.aspectRatio = `${info.width} / ${info.height}`;
    $('sRes').textContent = `${info.width}×${info.height}`;
    handle.reset();
    resetMediaClock();
  }

  function showSourceError(err: unknown) {
    console.error(err);
    badge.className = 'badge none';
    badge.textContent = `${SOURCE_WORD[mode]} 오류: ${(err as Error).message}`;
  }

  async function startCamera(deviceId: string | null) {
    mode = 'camera';
    cameraId = deviceId;
    syncSourceUi();
    const [w, h] = resSelect.value.split('x').map(Number);
    badge.className = 'badge none';
    badge.textContent = '카메라 연결 중';
    try {
      const info = await camera.start(deviceId, w, h);
      cameraId = savedCameraId();
      pref.set('res', resSelect.value);
      applySourceInfo(info);
    } catch (err) {
      showSourceError(err);
    }
  }

  async function startVideoFile(file: File) {
    mode = 'file';
    currentFile = file;
    fillSourceSelect(); // 목록에 '🎞 파일명' 항목을 넣는다
    badge.className = 'badge none';
    badge.textContent = '영상 여는 중';
    try {
      const info = await camera.startFile(file);
      video.playbackRate = Number(speedSelect.value);
      applySourceInfo(info);
    } catch (err) {
      showSourceError(err);
    }
    syncSourceUi();
  }

  async function startCapture() {
    mode = 'capture';
    fillSourceSelect();
    badge.className = 'badge none';
    badge.textContent = '캡처 연결 중';
    try {
      if (window.wakeline && captureSourceId) await window.wakeline.selectCaptureSource(captureSourceId);
      const info = await camera.startDisplay(() => {
        if (mode !== 'capture') return;
        latestLms = null;
        latestMetrics = null;
        badge.className = 'badge off';
        badge.textContent = '캡처가 끝났습니다';
      });
      applySourceInfo(info);
    } catch (err) {
      showSourceError(err);
    }
    syncSourceUi();
  }

  /** 캡처할 화면/창을 고른다. Electron은 자체 선택 창, 브라우저는 브라우저 기본 선택 창을 쓴다. */
  async function pickCapture() {
    const api = window.wakeline;
    if (api) {
      const chosen = await showCapturePicker(await api.listCaptureSources());
      if (!chosen) return;
      captureSourceId = chosen.id;
      captureName = chosen.name;
    } else {
      captureName = '화면 캡처';
    }
    mode = 'capture';
    if (cameraOn) await startCapture();
    else await setCameraOn(true);
  }

  /** 현재 모드의 입력을 (다시) 시작한다. */
  function startSource() {
    if (mode === 'file' && currentFile) return startVideoFile(currentFile);
    if (mode === 'capture' && captureName) return startCapture();
    return startCamera(cameraId);
  }

  function openFile(file: File) {
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(file.name)) {
      badge.className = 'badge none';
      badge.textContent = '동영상 파일이 아닙니다';
      return;
    }
    mode = 'file';
    currentFile = file;
    if (cameraOn) startVideoFile(file);
    else setCameraOn(true);
  }

  function fillSourceSelect() {
    camSelect.innerHTML = '';
    const add = (value: string, label: string, disabled = false) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.disabled = disabled;
      camSelect.appendChild(opt);
    };
    for (const c of cameraList) add(c.deviceId, `📷 ${c.label}`);
    if (!cameraList.length) add('', '카메라 없음', true);
    if (currentFile) add(FILE_LOADED, `🎞 ${currentFile.name}`);
    add(FILE_PICK, '📁 동영상 파일 열기…');
    if (captureName) add(CAPTURE_ACTIVE, `🖥 ${captureName}`);
    add(CAPTURE_PICK, '🖥 화면/창 캡처…');
    syncSourceUi();
  }

  function syncSourceUi() {
    const isFile = mode === 'file';
    if (mode === 'capture' && captureName) camSelect.value = CAPTURE_ACTIVE;
    else if (isFile && currentFile) camSelect.value = FILE_LOADED;
    else if (cameraId && cameraList.some((c) => c.deviceId === cameraId)) camSelect.value = cameraId;
    else if (!cameraList.length) camSelect.value = '';
    fileControls.hidden = !isFile;
    resSelect.disabled = mode !== 'camera';
    const what = SOURCE_WORD[mode];
    camToggle.textContent = cameraOn ? `${what} 끄기` : `${what} 켜기`;
    playBtn.textContent = video.paused ? '▶ 재생' : '⏸ 일시정지';
  }

  async function refreshCameraList() {
    try {
      cameraList = await listCameras();
    } catch {
      cameraList = [];
    }
    fillSourceSelect();
  }

  camSelect.addEventListener('change', () => {
    const v = camSelect.value;
    if (v === FILE_PICK) {
      syncSourceUi(); // 고르기 전 선택으로 되돌려 둔다
      fileInput.value = '';
      fileInput.click();
      return;
    }
    if (v === CAPTURE_PICK) {
      syncSourceUi();
      pickCapture();
      return;
    }
    if (v === FILE_LOADED) mode = 'file';
    else if (v === CAPTURE_ACTIVE) mode = 'capture';
    else {
      mode = 'camera';
      cameraId = v;
    }
    if (cameraOn) startSource();
    else setCameraOn(true);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) openFile(f);
  });
  resSelect.addEventListener('change', () => (cameraOn ? startCamera(cameraId) : setCameraOn(true)));
  navigator.mediaDevices.addEventListener('devicechange', refreshCameraList);

  // 창에 동영상 파일을 끌어다 놓아도 열린다.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  // ---------- 동영상 재생 조작 ----------
  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  function togglePlay() {
    if (mode !== 'file' || !cameraOn) return;
    if (video.paused) video.play();
    else video.pause();
  }
  playBtn.addEventListener('click', togglePlay);
  video.addEventListener('play', syncSourceUi);
  video.addEventListener('pause', syncSourceUi);
  seekBar.addEventListener('input', () => {
    if (mode !== 'file' || !Number.isFinite(video.duration)) return;
    video.currentTime = (Number(seekBar.value) / 1000) * video.duration;
    handle.reset();
  });
  speedSelect.addEventListener('change', () => {
    video.playbackRate = Number(speedSelect.value);
  });
  function updateSeekUi() {
    if (mode !== 'file' || !Number.isFinite(video.duration) || video.duration <= 0) return;
    if (document.activeElement !== seekBar) seekBar.value = String(Math.round((video.currentTime / video.duration) * 1000));
    timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }

  // ---------- 켜기/끄기 ----------
  // 끄면 카메라 스트림을 완전히 멈춰 표시등도 꺼지고, 자세 인식도 쉰다.
  let toggling = false;

  async function setCameraOn(on: boolean) {
    if (toggling) return;
    toggling = true;
    cameraOn = on;
    camToggle.classList.toggle('on', on);
    camToggle.classList.toggle('off', !on);
    camToggle.setAttribute('aria-pressed', String(on));
    camWrap.classList.toggle('off', !on);
    syncSourceUi();
    try {
      if (on) {
        await startSource();
      } else {
        if (vfcHandle !== null) video.cancelVideoFrameCallback(vfcHandle);
        vfcHandle = null;
        camera.stop();
        latestLms = null;
        latestMetrics = null;
        handle.reset();
        badge.className = 'badge off';
        badge.textContent = `${SOURCE_WORD[mode]} 꺼짐`;
        $('sRes').textContent = '-';
      }
    } finally {
      toggling = false;
      syncSourceUi();
    }
  }

  camToggle.addEventListener('click', () => setCameraOn(!cameraOn));
  window.addEventListener('keydown', (e) => {
    if (raceScreen.active) return; // 레이스 중에는 레이스 화면이 키를 처리한다
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // 한글 입력 상태에서도 동작하도록 e.code로 판별
    if (e.code === 'KeyC') {
      e.preventDefault();
      setCameraOn(!cameraOn);
    } else if (e.code === 'Space' && mode === 'file') {
      e.preventDefault();
      togglePlay();
    }
  });

  // ---------- 지표용 시계 ----------
  // 동영상은 재생 속도·반복과 상관없이 영상 속 시간으로 스트로크 시간을 재야 한다.
  // 반복이나 탐색으로 영상 시간이 되돌아가도 단조 증가하도록 이어 붙인다.
  const metricSamples: PoseMetrics[] = [];
  let mediaClock = 0;
  let lastMediaTime = -1;
  function resetMediaClock() {
    lastMediaTime = -1;
  }
  function metricTime(now: number, meta: VideoFrameCallbackMetadata): number {
    if (mode !== 'file') return now;
    let d = meta.mediaTime - lastMediaTime;
    if (lastMediaTime < 0 || d <= 0 || d > 1) d = 1 / 30;
    lastMediaTime = meta.mediaTime;
    mediaClock += d * 1000;
    return mediaClock;
  }
  const clockNow = () => (mode === 'file' ? mediaClock : performance.now());

  // ---------- 프레임마다 자세 인식 ----------
  function onVideoFrame(now: number, meta: VideoFrameCallbackMetadata) {
    camRate.tick(now);
    if (tracker.ready && !modelBusy && video.readyState >= 2) {
      const t = metricTime(now, meta);
      const { landmarks, inferenceMs } = tracker.detect(video);
      poseRate.tick(now);
      infer.push(inferenceMs);
      latestLms = landmarks;
      latestMetrics = handle.update(landmarks, camSize.width / camSize.height, t);
      graph.push({ t: performance.now(), index: latestMetrics.index, knee: latestMetrics.kneeAngleDeg });
      metricSamples.push(latestMetrics);
      if (checkMode) check.push({ t, landmarks, metrics: latestMetrics, aspect: camSize.width / camSize.height });
      if (raceScreen.active) raceScreen.onPose(performance.now(), latestMetrics.index, latestMetrics.status !== 'none');
      recorder.push(t, landmarks);
    }
    vfcHandle = video.requestVideoFrameCallback(onVideoFrame);
  }

  /** 입력을 (다시) 시작할 때마다 프레임 루프를 하나만 걸어둔다. */
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
    if (!checkMode && !raceScreen.active) stress?.render();

    const status = latestMetrics?.status ?? 'none';
    const side = latestMetrics?.side ?? 'left';
    if (cameraOn) overlay.draw(latestLms, status, side, det.minVisibility);
    else overlay.clear();
    graph.draw(now);
    updateSeekUi();

    if (now - lastStats > 250) {
      lastStats = now;
      if (checkMode) {
        if (cameraOn && camera.kind !== 'none') brightness = measureBrightness() ?? brightness;
        checkView.render(check.evaluate(camRate.rate(now), cameraOn ? brightness : null));
      }
      if (cameraOn && camera.kind !== 'none') {
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

  // ---------- 밝기 측정 (점검 모드) ----------
  const lumaCanvas = document.createElement('canvas');
  lumaCanvas.width = 32;
  lumaCanvas.height = 18;
  const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true })!;
  function measureBrightness(): number | null {
    if (video.readyState < 2) return null;
    try {
      lumaCtx.drawImage(video, 0, 0, lumaCanvas.width, lumaCanvas.height);
      const d = lumaCtx.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return sum / (d.length / 4);
    } catch {
      return null;
    }
  }

  // ---------- 카메라 점검 모드 ----------
  async function setCheckMode(on: boolean) {
    checkMode = on;
    document.body.classList.toggle('check-mode', on);
    $('checkPanel').hidden = !on;
    check.reset();
    brightness = null;
    if (on && !cameraOn) await setCameraOn(true);
  }
  $('checkBtn').addEventListener('click', () => setCheckMode(true));
  $('checkClose').addEventListener('click', () => setCheckMode(false));
  $('checkRestart').addEventListener('click', () => {
    check.reset();
    brightness = null;
  });
  window.addEventListener('keydown', (e) => {
    if (raceScreen.active) return;
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'KeyK') {
      e.preventDefault();
      setCheckMode(!checkMode);
    } else if (e.code === 'Escape' && checkMode) {
      e.preventDefault();
      setCheckMode(false);
    }
  });

  // ---------- 레이스 ----------
  const raceDifficulty = $<HTMLSelectElement>('raceDifficulty');
  const raceDistance = $<HTMLSelectElement>('raceDistance');
  const raceOpponent = $<HTMLSelectElement>('raceOpponent');
  for (const d of config.race.distancesM) {
    const opt = document.createElement('option');
    opt.value = String(d);
    opt.textContent = d >= 1000 ? `${d / 1000}km` : `${d}m`;
    raceDistance.appendChild(opt);
  }
  raceDifficulty.value = pref.get('race.difficulty', 'normal');
  raceDistance.value = pref.get('race.distance', String(config.race.defaultDistanceM));
  if (!raceDistance.value) raceDistance.value = String(config.race.defaultDistanceM);
  raceOpponent.value = pref.get('race.opponent', 'ai');

  const raceScreen = new RaceScreen(config, hanRiver, {
    onExit: () => {
      if (stressToggle.checked) setStress(true);
    },
    onFinish: (s) => {
      window.wakeline?.sendMetrics(
        `race ${s.status} time=${formatTime(s.totalTimeMs, true)} dist=${s.distanceM.toFixed(0)} split=${formatTime(s.avgSplitSec * 1000, true)} spm=${s.avgSpm.toFixed(1)} strokes=${s.strokeCount} rank=${s.rank}/${s.boats}`,
      );
    },
  });

  async function startRace(distanceM: number, difficulty: DifficultyId, opponent: OpponentKind) {
    if (checkMode) await setCheckMode(false);
    if (!cameraOn) await setCameraOn(true);
    setStress(false);
    pref.set('race.difficulty', difficulty);
    pref.set('race.distance', String(distanceM));
    pref.set('race.opponent', opponent);
    raceScreen.start({ mapId: hanRiver.id, distanceM, difficulty, opponent });
  }
  $('raceStartBtn').addEventListener('click', () =>
    startRace(Number(raceDistance.value), raceDifficulty.value as DifficultyId, raceOpponent.value as OpponentKind),
  );

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
      recorder.start(
        camSize.width,
        camSize.height,
        `${tracker.model}/${tracker.delegate}`,
        mode === 'file' && currentFile ? `file:${currentFile.name}` : 'camera',
        clockNow(),
      );
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
  await Promise.all([initModel(), startCamera(cameraId)]);
  await refreshCameraList();
  await setupTestHooks();

  // ---------- 테스트 지원 (Electron 실행 옵션으로만 켜짐) ----------
  async function setupTestHooks() {
    const api = window.wakeline;
    if (!api) return;
    const cfg = await api.getTestConfig();

    if (cfg.logMetrics) {
      setInterval(() => {
        const ss = metricSamples.splice(0);
        const idx = ss.map((m) => m.index).filter((v): v is number => v !== null);
        const raw = ss.map((m) => m.raw).filter((v): v is number => v !== null);
        const knee = ss.map((m) => m.kneeAngleDeg).filter((v): v is number => v !== null);
        const count = (st: string) => ss.filter((m) => m.status === st).length;
        const range = (a: number[], d = 2) => (a.length ? `${Math.min(...a).toFixed(d)}..${Math.max(...a).toFixed(d)}` : '-');
        const now = performance.now();
        api.sendMetrics(
          [
            `src=${mode}`,
            `frames=${ss.length}`,
            `ok/partial/none=${count('ok')}/${count('partial')}/${count('none')}`,
            `side=${ss.at(-1)?.side ?? '-'}`,
            `cam=${camRate.rate(now).toFixed(0)}fps`,
            `pose=${poseRate.rate(now).toFixed(0)}fps`,
            `infer=${infer.mean.toFixed(1)}ms`,
            `res=${camSize.width}x${camSize.height}`,
            `index=${range(idx)}`,
            `raw=${range(raw)}`,
            `knee=${range(knee, 0)}`,
          ].join(' '),
        );
        const race = raceScreen.race;
        if (race) {
          const st = race.standings();
          api.sendMetrics(
            `race phase=${race.phase} t=${formatTime(race.elapsedMs, true)} dist=${race.player.distance.toFixed(1)} ` +
              `v=${race.player.speed.toFixed(2)} split=${race.splitSec ? formatTime(race.splitSec * 1000, true) : '-'} ` +
              `spm=${race.spm.toFixed(1)} strokes=${race.strokes.length} rank=${st.findIndex((b) => b.id === 'player') + 1}/${st.length} ` +
              `ai=[${race.ais.map((a) => a.distance.toFixed(0)).join(',')}]`,
          );
        }
        if (checkMode) {
          const r = check.evaluate(camRate.rate(now), brightness);
          api.sendMetrics(
            `check ready=${r.ready} strokes=${r.strokeCount} light=${brightness?.toFixed(0) ?? '-'} ` +
              r.items.map((i) => `${i.id}:${i.state}(${i.detail})`).join(' ') +
              ` | ${r.guidance}`,
          );
        }
      }, 1000);
    }

    if (cfg.startCheck) await setCheckMode(true);

    if (cfg.captureTitle) {
      const wanted = cfg.captureTitle.toLowerCase();
      for (let i = 0; i < 30; i++) {
        const src = (await api.listCaptureSources()).find((x) => x.name.toLowerCase().includes(wanted));
        if (src) {
          captureSourceId = src.id;
          captureName = src.name;
          api.sendMetrics(`capture source selected: ${src.name}`);
          if (cameraOn) await startCapture();
          else await setCameraOn(true);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (i === 29) api.sendMetrics(`capture source not found: ${cfg.captureTitle}`);
      }
    }

    if (cfg.startRace) {
      // 자세 인식이 자리 잡을 시간을 조금 준 뒤 출발한다.
      await new Promise((r) => setTimeout(r, 3000));
      await startRace(cfg.startRace, (cfg.raceDifficulty as DifficultyId) ?? 'normal', 'ai');
    }
  }
}

/** 캡처할 화면/창 선택 창. 고르면 그 소스를, 취소하면 null을 돌려준다. */
function showCapturePicker(sources: CaptureSource[]): Promise<CaptureSource | null> {
  const modal = $<HTMLDivElement>('capturePicker');
  const list = $<HTMLDivElement>('captureList');
  const cancel = $<HTMLButtonElement>('captureCancel');
  list.innerHTML = '';
  return new Promise((resolve) => {
    const done = (v: CaptureSource | null) => {
      modal.hidden = true;
      cancel.onclick = null;
      resolve(v);
    };
    if (!sources.length) list.textContent = '캡처할 수 있는 화면이나 창이 없습니다.';
    for (const src of sources) {
      const b = document.createElement('button');
      b.className = 'capture-item';
      const img = document.createElement('img');
      img.src = src.thumbnail;
      img.alt = '';
      const label = document.createElement('span');
      label.textContent = `${src.kind === 'screen' ? '🖥' : '🗔'} ${src.name}`;
      b.append(img, label);
      b.onclick = () => done(src);
      list.appendChild(b);
    }
    cancel.onclick = () => done(null);
    modal.hidden = false;
  });
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
