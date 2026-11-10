// 로잉 테스트 영상 생성기.
// 헬스장 로잉머신에서 노를 젓는 사람을 3D로 그리고, 옆·약간 뒤쪽에서 전신이 보이게 찍는다.
// 영상 길이를 스트로크 주기의 정수배로 맞춰 반복 재생해도 끊김이 없다.
//
// 주소 옵션: ?spm=24&seconds=30&cam=side-rear|side
// 녹화: window.__record(초) → webm(base64)을 돌려준다(scripts/make-rower-video.cjs가 호출).

import * as THREE from 'three';

const params = new URLSearchParams(location.search);
const SPM = Number(params.get('spm') ?? 24);
const PERIOD = 60 / SPM; // 초
const DRIVE = 0.36; // 한 스트로크에서 드라이브가 차지하는 비율(나머지는 리커버리)
const CAM = params.get('cam') ?? 'side-rear';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9dcdf');
const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 50);

// ---------- 조명 ----------
scene.add(new THREE.HemisphereLight('#ffffff', '#6b6f75', 1.1));
const key = new THREE.DirectionalLight('#fff6ea', 2.2);
key.position.set(1.5, 4, 3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -3;
scene.add(key);
const fill = new THREE.PointLight('#ffffff', 6, 12);
fill.position.set(-2, 2.5, 2.5);
scene.add(fill);

// ---------- 헬스장 ----------
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

const floorTex = canvasTex(512, 512, (g) => {
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 50 + Math.random() * 30;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  for (let i = 0; i <= 512; i += 256) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 512);
    g.moveTo(0, i);
    g.lineTo(512, i);
    g.stroke();
  }
}, 8);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const wallMat = new THREE.MeshStandardMaterial({ color: '#e9e6e1', roughness: 0.9 });
const backWall = new THREE.Mesh(new THREE.PlaneGeometry(16, 5), wallMat);
backWall.position.set(0, 2.5, -2.6);
backWall.receiveShadow = true;
scene.add(backWall);
const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(16, 5), wallMat);
sideWall.rotation.y = Math.PI / 2;
sideWall.position.set(-4.5, 2.5, 0);
scene.add(sideWall);
// 벽 아래 띠, 거울, 랙
const stripe = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 0.02), new THREE.MeshStandardMaterial({ color: '#2f5d8a' }));
stripe.position.set(0, 0.9, -2.58);
scene.add(stripe);
const mirror = new THREE.Mesh(
  new THREE.PlaneGeometry(5, 1.8),
  new THREE.MeshStandardMaterial({ color: '#b8c4cf', metalness: 0.1, roughness: 0.15 }),
);
mirror.position.set(1.2, 2.1, -2.57);
scene.add(mirror);
const rackMat = new THREE.MeshStandardMaterial({ color: '#202225', roughness: 0.5, metalness: 0.6 });
for (let i = 0; i < 6; i++) {
  const db = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.32, 16), rackMat);
  db.rotation.z = Math.PI / 2;
  db.position.set(-3.2 + i * 0.4, 0.55, -2.25);
  scene.add(db);
}
const rack = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.45), rackMat);
rack.position.set(-2.2, 0.45, -2.25);
scene.add(rack);

// ---------- 로잉머신 ----------
// x+ 방향이 앞(플라이휠), 사람은 x+를 보고 앉는다.
const metal = new THREE.MeshStandardMaterial({ color: '#2b2d31', roughness: 0.45, metalness: 0.6 });
const alu = new THREE.MeshStandardMaterial({ color: '#b9bec5', roughness: 0.3, metalness: 0.85 });
const black = new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.6 });
const erg = new THREE.Group();
scene.add(erg);
const rail = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.05, 0.11), alu);
rail.position.set(0.15, 0.36, 0);
rail.castShadow = true;
erg.add(rail);
const backLeg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.5), metal);
backLeg.position.set(-0.82, 0.17, 0);
erg.add(backLeg);
const frontFrame = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.08, 0.5), metal);
frontFrame.position.set(1.4, 0.06, 0);
erg.add(frontFrame);
const upright = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), metal);
upright.position.set(1.18, 0.33, 0);
upright.rotation.z = 0.5;
erg.add(upright);
const fly = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.26, 40), black);
fly.rotation.x = Math.PI / 2;
fly.position.set(1.6, 0.62, 0);
fly.castShadow = true;
erg.add(fly);
const flyRim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 8, 40), alu);
flyRim.position.set(1.6, 0.62, 0.13);
erg.add(flyRim);
const monArm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 8), metal);
monArm.position.set(1.42, 1.05, 0);
monArm.rotation.z = 0.5;
erg.add(monArm);
const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.2), black);
monitor.position.set(1.28, 1.3, 0);
erg.add(monitor);
for (const z of [-0.11, 0.11]) {
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.12), metal);
  plate.position.set(1.02, 0.3, z);
  plate.rotation.z = 0.75;
  erg.add(plate);
}
const seat = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.3), black);
seat.castShadow = true;
erg.add(seat);
const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 12), black);
handleBar.rotation.x = Math.PI / 2;
handleBar.castShadow = true;
erg.add(handleBar);
const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 6), alu);
erg.add(chain);

// ---------- 사람 ----------
const UP = new THREE.Vector3(0, 1, 0);
const skin = new THREE.MeshStandardMaterial({ color: '#c8936f', roughness: 0.62 });
const shirt = new THREE.MeshStandardMaterial({ color: '#c0392b', roughness: 0.8 });
const shorts = new THREE.MeshStandardMaterial({ color: '#1c1d22', roughness: 0.85 });
const shoeMat = new THREE.MeshStandardMaterial({ color: '#f1f1f1', roughness: 0.6 });
const hairMat = new THREE.MeshStandardMaterial({ color: '#21170f', roughness: 0.9 });

const unitSphere = new THREE.SphereGeometry(1, 20, 14);

/** a→b를 잇는 둥근 팔다리(원기둥 + 양끝 구) — 굵기가 끝으로 갈수록 가늘어진다 */
class Limb {
  private cyl: THREE.Mesh;
  private capA: THREE.Mesh;
  private capB: THREE.Mesh;
  constructor(mat: THREE.Material, rA: number, rB: number) {
    const geo = new THREE.CylinderGeometry(rB, rA, 1, 18);
    this.cyl = new THREE.Mesh(geo, mat);
    this.capA = new THREE.Mesh(unitSphere, mat);
    this.capB = new THREE.Mesh(unitSphere, mat);
    this.capA.scale.setScalar(rA);
    this.capB.scale.setScalar(rB);
    for (const m of [this.cyl, this.capA, this.capB]) {
      m.castShadow = true;
      scene.add(m);
    }
  }
  set(a: THREE.Vector3, b: THREE.Vector3): void {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    this.cyl.position.copy(a).addScaledVector(d, 0.5);
    this.cyl.scale.set(1, len, 1);
    this.cyl.quaternion.setFromUnitVectors(UP, d.normalize());
    this.capA.position.copy(a);
    this.capB.position.copy(b);
  }
}

function ik(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, bend: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(a.distanceTo(c), l1 + l2 - 1e-3);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const axis = new THREE.Vector3().subVectors(c, a).normalize();
  const perp = bend.clone().addScaledVector(axis, -bend.dot(axis)).normalize();
  return a.clone().addScaledVector(axis, x).addScaledVector(perp, h);
}

const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.3, 8, 20), shirt);
torso.castShadow = true;
scene.add(torso);
const pelvis = new THREE.Mesh(unitSphere, shorts);
pelvis.scale.set(0.15, 0.12, 0.19);
pelvis.castShadow = true;
scene.add(pelvis);
const neck = new Limb(skin, 0.05, 0.05);
const head = new THREE.Mesh(unitSphere, skin);
head.scale.set(0.1, 0.12, 0.095);
head.castShadow = true;
scene.add(head);
const hair = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
hair.scale.set(0.105, 0.125, 0.1);
scene.add(hair);
const nose = new THREE.Mesh(unitSphere, skin);
nose.scale.setScalar(0.022);
scene.add(nose);

const sides = [-1, 1] as const;
const limbs = sides.map(() => ({
  thigh: new Limb(shorts, 0.09, 0.065),
  shin: new Limb(skin, 0.06, 0.042),
  upper: new Limb(shirt, 0.055, 0.045),
  fore: new Limb(skin, 0.042, 0.032),
  hand: (() => {
    const h = new THREE.Mesh(unitSphere, skin);
    h.scale.set(0.05, 0.04, 0.045);
    h.castShadow = true;
    scene.add(h);
    return h;
  })(),
  shoe: (() => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.08, 0.1), shoeMat);
    s.castShadow = true;
    scene.add(s);
    return s;
  })(),
}));

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 한 스트로크 안의 위치 p(0=캐치)로 다리·몸통·팔 진행도(0=캐치 자세, 1=피니시 자세)를 구한다. */
function phaseAmounts(p: number): { legs: number; body: number; arms: number } {
  if (p < DRIVE) {
    // 드라이브: 다리 → 몸통 → 팔
    const u = p / DRIVE;
    return { legs: smooth(0, 0.55, u), body: smooth(0.3, 0.8, u), arms: smooth(0.6, 1, u) };
  }
  // 리커버리: 팔 → 몸통 → 다리
  const w = (p - DRIVE) / (1 - DRIVE);
  return { legs: 1 - smooth(0.4, 1, w), body: 1 - smooth(0.12, 0.45, w), arms: 1 - smooth(0, 0.25, w) };
}

function poseAt(p: number): void {
  const { legs, body, arms } = phaseAmounts(p);
  const hip = new THREE.Vector3(THREE.MathUtils.lerp(0.5, 0.04, legs), 0.54, 0);
  seat.position.set(hip.x - 0.02, 0.42, 0);

  const lean = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(30, -24, body));
  const dir = new THREE.Vector3(Math.sin(lean), Math.cos(lean), 0);
  const shoulder = hip.clone().addScaledVector(dir, 0.52);

  pelvis.position.copy(hip).addScaledVector(dir, 0.04);
  pelvis.quaternion.setFromUnitVectors(UP, dir);
  torso.position.copy(hip).addScaledVector(dir, 0.3);
  torso.quaternion.setFromUnitVectors(UP, dir);
  torso.scale.set(0.82, 1, 1.15); // 앞뒤로 얇고 좌우로 넓게

  const neckBase = hip.clone().addScaledVector(dir, 0.58);
  const headC = neckBase.clone().addScaledVector(dir, 0.13).add(new THREE.Vector3(0.025, 0, 0));
  neck.set(neckBase, headC);
  head.position.copy(headC);
  head.quaternion.setFromUnitVectors(UP, dir);
  hair.position.copy(headC).add(new THREE.Vector3(-0.01, 0.01, 0));
  hair.quaternion.copy(head.quaternion);
  nose.position.copy(headC).add(new THREE.Vector3(0.095, -0.01, 0));

  // 핸들: 캐치 때 팔을 쭉 뻗고, 피니시 때 명치까지 당긴다(높이는 거의 수평)
  const handleY = THREE.MathUtils.lerp(0.72, 0.8, arms);
  const dy = shoulder.y - handleY;
  const reachX = shoulder.x + Math.sqrt(Math.max(0, 0.6 * 0.6 - dy * dy));
  const chestX = shoulder.x + 0.26;
  const handleX = THREE.MathUtils.lerp(reachX, chestX, arms);
  handleBar.position.set(handleX, handleY, 0);
  // 체인: 핸들 → 플라이휠
  const chainA = new THREE.Vector3(handleX + 0.02, handleY, 0);
  const chainB = new THREE.Vector3(1.45, 0.66, 0);
  const cd = new THREE.Vector3().subVectors(chainB, chainA);
  chain.position.copy(chainA).addScaledVector(cd, 0.5);
  chain.scale.set(1, cd.length(), 1);
  chain.quaternion.setFromUnitVectors(UP, cd.normalize());

  sides.forEach((s, i) => {
    const L = limbs[i];
    const hipS = hip.clone().add(new THREE.Vector3(0, 0, s * 0.1));
    const ankle = new THREE.Vector3(0.98, 0.32, s * 0.11);
    const knee = ik(hipS, ankle, 0.46, 0.44, new THREE.Vector3(0.2, 1, s * 0.15));
    L.thigh.set(hipS, knee);
    L.shin.set(knee, ankle);
    L.shoe.position.set(1.06, 0.36, s * 0.11);
    L.shoe.rotation.z = 0.75;

    const sh = shoulder.clone().add(new THREE.Vector3(0, -0.02, s * 0.19));
    const hand = new THREE.Vector3(handleX, handleY, s * 0.19);
    const elbow = ik(sh, hand, 0.3, 0.29, new THREE.Vector3(-1, -0.5, s * 0.7));
    L.upper.set(sh, elbow);
    L.fore.set(elbow, hand);
    L.hand.position.copy(hand);
  });
}

// ---------- 카메라 ----------
function placeCamera(): void {
  if (CAM === 'side') {
    camera.position.set(0.45, 0.95, 3.4);
    camera.lookAt(0.45, 0.62, 0);
  } else {
    // 옆, 약간 뒤쪽(사람 등 쪽)에서. 전신과 플라이휠까지 들어오게.
    camera.position.set(-1.0, 1.12, 2.3);
    camera.lookAt(0.5, 0.62, 0);
  }
}
placeCamera();

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let t0 = performance.now();
function frame(): void {
  const t = (performance.now() - t0) / 1000;
  const p = (t / PERIOD) % 1;
  poseAt(p);
  fly.rotation.y += 0.05;
  renderer.render(scene, camera);
  info.textContent = `${SPM}SPM · ${CAM} · ${(t % 60).toFixed(1)}s`;
  requestAnimationFrame(frame);
}
frame();

// ---------- 녹화 ----------
declare global {
  interface Window {
    __record(seconds: number): Promise<string>;
  }
}

window.__record = async (seconds: number) => {
  // 스트로크 주기의 정수배로 맞춰 반복 재생이 자연스럽게 이어지게 한다.
  const strokes = Math.max(1, Math.round(seconds / PERIOD));
  const durationMs = strokes * PERIOD * 1000;
  info.hidden = true;
  const stream = canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))!;
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  t0 = performance.now(); // 캐치 자세에서 시작
  rec.start(500);
  await new Promise((r) => setTimeout(r, durationMs));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  info.hidden = false;
  return btoa(bin);
};
