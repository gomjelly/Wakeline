// 3D 한강 레이스 장면. 노을 하늘, 반사되는 강물, 강변 빌딩 숲, 다리, 레인 부표, 결승선, 보트들.
// 에셋 파일 없이 코드로 만든다(맵 정의 JSON의 다리 위치를 쓴다).

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import type { MapDefinition } from '../config';
import { RowingBoat, type RowerColors } from './rower';

export const LANE_WIDTH = 13.5;

export interface BoatSpec {
  label: string;
  ghost?: boolean;
}

export interface BoatRenderState {
  distance: number;
  index: number;
  driving: boolean;
  label?: string;
}

const PALETTE: RowerColors[] = [
  { hull: '#f4f4f4', jersey: '#ff4d4d', blade: '#ff4d4d' }, // 플레이어: 빨강
  { hull: '#ffd23f', jersey: '#2f6bff', blade: '#2f6bff' },
  { hull: '#e9e9e9', jersey: '#1fb57a', blade: '#1fb57a' },
  { hull: '#9ad1ff', jersey: '#ff9f1c', blade: '#ff9f1c' },
  { hull: '#f4f4f4', jersey: '#9b5de5', blade: '#9b5de5' },
  { hull: '#ffd23f', jersey: '#00bbf9', blade: '#00bbf9' },
];

const GHOST_COLORS: RowerColors = { hull: '#dff3ff', jersey: '#bfe6ff', blade: '#bfe6ff', skin: '#dff3ff' };

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 물결 노멀맵(반복 가능한 사인파 합성) */
function waterNormalTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const waves = Array.from({ length: 12 }, (_, i) => ({
    kx: Math.round(Math.cos(i * 2.39996) * (2 + i * 1.3)),
    ky: Math.round(Math.sin(i * 2.39996) * (2 + i * 1.3)),
    a: 1 / (1 + i * 0.45),
    p: i * 1.7,
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const w of waves) {
        const ph = ((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p;
        const c = Math.cos(ph) * w.a;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const n = new THREE.Vector3(-dx * 0.04, -dy * 0.04, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 빌딩 창문 텍스처(저녁이라 일부만 불이 켜짐) */
function windowTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(128, 256, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 128, 256);
    for (let y = 6; y < 256; y += 12) {
      for (let x = 6; x < 128; x += 12) {
        if (Math.random() < 0.38) {
          const warm = Math.random();
          g.fillStyle = warm < 0.7 ? `rgba(255, ${200 + warm * 40}, 140, 1)` : 'rgba(190, 220, 255, 1)';
          g.fillRect(x, y, 7, 7);
        }
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function textSprite(text: string, opts: { size?: number; color?: string; bg?: string; width?: number } = {}): THREE.Sprite {
  const w = opts.width ?? 512;
  const h = 128;
  const tex = canvasTexture(w, h, (g) => {
    if (opts.bg) {
      g.fillStyle = opts.bg;
      g.beginPath();
      g.roundRect(4, 4, w - 8, h - 8, 28);
      g.fill();
    }
    g.font = `800 ${opts.size ?? 72}px 'Pretendard', 'Malgun Gothic', sans-serif`;
    g.fillStyle = opts.color ?? '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set((w / h) * 1, 1, 1);
  return sprite;
}

export class RaceScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 9000);
  private water: Water;
  private sun = new THREE.DirectionalLight('#ffd2a1', 2.4);
  private sunDir = new THREE.Vector3();
  private boats: RowingBoat[] = [];
  private labels: (THREE.Sprite | null)[] = [];
  private laneX: number[] = [];
  private camPos = new THREE.Vector3(10, 6, 22);
  private camTarget = new THREE.Vector3();
  private clock = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    map: MapDefinition,
    distanceM: number,
    specs: BoatSpec[],
  ) {
    const boatCount = specs.length;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const length = distanceM + 1500;
    this.scene.fog = new THREE.FogExp2('#c98a6b', 0.00042);

    // ---------- 하늘 + 해 ----------
    const sky = new Sky();
    sky.scale.setScalar(8000);
    const su = sky.material.uniforms;
    su.turbidity.value = 8;
    su.rayleigh.value = 2.2;
    su.mieCoefficient.value = 0.006;
    su.mieDirectionalG.value = 0.86;
    const phi = THREE.MathUtils.degToRad(90 - map.sunElevationDeg);
    const theta = THREE.MathUtils.degToRad(180); // 해가 결승선 쪽(-Z)에 진다
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    su.sunPosition.value.copy(this.sunDir);
    this.scene.add(sky);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene).texture;

    this.scene.add(new THREE.HemisphereLight('#ffc7a0', '#22304d', 0.5));
    this.sun.position.copy(this.sunDir).multiplyScalar(200);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -60;
    sc.right = 60;
    sc.top = 60;
    sc.bottom = -60;
    sc.far = 600;
    this.scene.add(this.sun, this.sun.target);

    // ---------- 강물 ----------
    this.water = new Water(new THREE.PlaneGeometry(map.riverWidthM + 400, length + 4000), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: waterNormalTexture(),
      sunDirection: this.sunDir.clone(),
      sunColor: '#ffd9b0',
      waterColor: '#16324a',
      distortionScale: 1.1,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.z = -length / 2 + 800;
    (this.water.material as THREE.ShaderMaterial).uniforms.size.value = 3.5;
    // 이름표는 물에 비치지 않게 반사를 그리는 동안만 숨긴다.
    const drawReflection = this.water.onBeforeRender.bind(this.water);
    this.water.onBeforeRender = (...args) => {
      for (const l of this.labels) if (l) l.visible = false;
      drawReflection(...args);
      for (const l of this.labels) if (l) l.visible = true;
    };
    this.scene.add(this.water);

    this.buildBanks(map.riverWidthM, length);
    this.buildBridges(map, distanceM);
    this.buildLanes(specs, distanceM);
    this.buildFinish(boatCount, distanceM);

    // ---------- 보트 ----------
    for (let i = 0; i < boatCount; i++) {
      const spec = specs[i];
      const boat = new RowingBoat(spec.ghost ? GHOST_COLORS : PALETTE[i % PALETTE.length]);
      if (spec.ghost) boat.makeGhost();
      boat.group.position.x = this.laneX[i];
      this.scene.add(boat.group);
      this.boats.push(boat);
      // 플레이어 배에는 이름표를 달지 않는다(배를 가리지 않게).
      const text = i === 0 ? '' : spec.label;
      if (text) {
        const s = textSprite(text, {
          size: text.length > 9 ? 44 : 64,
          bg: spec.ghost ? 'rgba(60,120,170,0.6)' : 'rgba(11,18,32,0.75)',
          width: text.length > 9 ? 640 : 384,
        });
        s.scale.multiplyScalar(1.3);
        this.scene.add(s);
        this.labels.push(s);
      } else this.labels.push(null);
    }
  }

  private buildBanks(riverWidth: number, length: number): void {
    const half = riverWidth / 2;
    const zMid = -length / 2 + 600;
    const bankLen = length + 3000;

    // 둔치(풀밭) + 강변도로 + 제방
    const grass = new THREE.MeshStandardMaterial({ color: '#3d5a34', roughness: 1 });
    const road = new THREE.MeshStandardMaterial({ color: '#3b3f47', roughness: 0.9 });
    const wall = new THREE.MeshStandardMaterial({ color: '#8b8f96', roughness: 0.9 });
    for (const side of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(120, 2, bankLen), grass);
      g.position.set(side * (half + 60), 0.5, zMid);
      g.receiveShadow = true;
      const w = new THREE.Mesh(new THREE.BoxGeometry(6, 4, bankLen), wall);
      w.position.set(side * (half + 3), 1.5, zMid);
      const r = new THREE.Mesh(new THREE.BoxGeometry(40, 6, bankLen), road);
      r.position.set(side * (half + 140), 2.5, zMid);
      this.scene.add(g, w, r);

      // 가로등 불빛 줄
      const lampMat = new THREE.MeshBasicMaterial({ color: '#ffcf87' });
      const lampGeo = new THREE.SphereGeometry(0.6, 6, 4);
      const n = Math.floor(bankLen / 40);
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        m.makeTranslation(side * (half + 12), 7, zMid + bankLen / 2 - i * 40);
        lamps.setMatrixAt(i, m);
      }
      this.scene.add(lamps);
    }

    // 빌딩 숲 (아파트 + 고층 빌딩), 인스턴싱
    const winTex = windowTexture();
    const bMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.75,
      metalness: 0.1,
      emissive: '#ffffff',
      emissiveMap: winTex,
      emissiveIntensity: 1.6,
    });
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    bGeo.translate(0, 0.5, 0);
    const count = Math.floor((bankLen / 18) * 2 * 3);
    const buildings = new THREE.InstancedMesh(bGeo, bMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const tones = ['#6d7487', '#8a8f9e', '#a59d95', '#5a6274', '#c2b8ad', '#7b8394'];
    let k = 0;
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        for (let z = zMid + bankLen / 2; z > zMid - bankLen / 2 && k < count; z -= 18 + Math.random() * 10) {
          const tall = Math.random() < 0.12;
          const h = tall ? 70 + Math.random() * 110 : 25 + Math.random() * 45;
          const w = 12 + Math.random() * 14;
          const d = 12 + Math.random() * 14;
          const x = side * (half + 190 + row * 45 + Math.random() * 20);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.2);
          m.compose(new THREE.Vector3(x, 4, z), q, new THREE.Vector3(w, h, d));
          buildings.setMatrixAt(k, m);
          buildings.setColorAt(k, col.set(tones[Math.floor(Math.random() * tones.length)]));
          k++;
        }
      }
    }
    buildings.count = k;
    this.scene.add(buildings);

    // 먼 산 실루엣
    const hillMat = new THREE.MeshStandardMaterial({ color: '#3a3550', roughness: 1 });
    for (let i = 0; i < 18; i++) {
      const r = 250 + Math.random() * 350;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(r, 120 + Math.random() * 160, 7), hillMat);
      const side = i % 2 ? 1 : -1;
      hill.position.set(side * (half + 900 + Math.random() * 900), 0, zMid + (Math.random() - 0.5) * bankLen);
      this.scene.add(hill);
    }
  }

  private buildBridges(map: MapDefinition, distanceM: number): void {
    const width = map.riverWidthM + 80;
    const deckMat = new THREE.MeshStandardMaterial({ color: '#7d8590', roughness: 0.7 });
    const pierMat = new THREE.MeshStandardMaterial({ color: '#9aa1aa', roughness: 0.8 });
    const archMat = new THREE.MeshStandardMaterial({ color: '#d9dde3', roughness: 0.4, metalness: 0.4 });
    const lightMat = new THREE.MeshBasicMaterial({ color: '#ffe2a8' });

    for (const [bi, b] of map.bridges.entries()) {
      if (b.distanceM > distanceM + 900) continue;
      const z = -b.distanceM;
      const g = new THREE.Group();
      g.position.z = z;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 2.2, 26), deckMat);
      deck.position.y = 14;
      deck.castShadow = true;
      g.add(deck);
      // 교각: 레인(가운데 120m)은 비워 둔다
      for (let x = -width / 2 + 30; x < width / 2; x += 60) {
        if (Math.abs(x) < 70) continue;
        const pier = new THREE.Mesh(new THREE.BoxGeometry(6, 14, 18), pierMat);
        pier.position.set(x, 6, 0);
        g.add(pier);
      }
      // 아치(다리마다 모양을 조금 다르게)
      if (bi % 2 === 0) {
        const arch = new THREE.Mesh(new THREE.TorusGeometry(70, 1.2, 8, 48, Math.PI), archMat);
        arch.position.y = 15;
        g.add(arch);
        for (let x = -60; x <= 60; x += 12) {
          const hgt = Math.sqrt(Math.max(0, 70 * 70 - x * x));
          const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, hgt, 4), archMat);
          cable.position.set(x, 15 + hgt / 2, 0);
          g.add(cable);
        }
      }
      // 난간 조명
      const n = Math.floor(width / 10);
      const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 6, 4), lightMat, n * 2);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        m.makeTranslation(-width / 2 + i * 10, 15.8, 13.2);
        lights.setMatrixAt(i * 2, m);
        m.makeTranslation(-width / 2 + i * 10, 15.8, -13.2);
        lights.setMatrixAt(i * 2 + 1, m);
      }
      g.add(lights);
      // 다리 이름판(다가오는 쪽에서 보이게)
      const sign = textSprite(b.name, { size: 78, bg: 'rgba(15, 40, 80, 0.85)' });
      sign.scale.set(24, 6, 1);
      sign.position.set(0, 21, 14);
      g.add(sign);
      this.scene.add(g);
    }
  }

  private buildLanes(specs: BoatSpec[], distanceM: number): void {
    const boatCount = specs.length;
    const lanes = Math.max(boatCount, 3);
    const first = Math.floor((lanes - 1) / 2);
    // 플레이어(0번)를 가운데 레인에, 나머지를 양옆에 번갈아 놓는다.
    const order: number[] = [first];
    for (let d = 1; order.length < boatCount; d++) {
      if (first + d < lanes) order.push(first + d);
      if (order.length < boatCount && first - d >= 0) order.push(first - d);
    }
    const x0 = -((lanes - 1) / 2) * LANE_WIDTH;
    // 레인 배정 우선순위: 플레이어 → 고스트(가장 중요한 비교 대상이라 바로 옆) → AI
    const priority = [
      0,
      ...specs.map((sp, i) => (i > 0 && sp.ghost ? i : -1)).filter((i) => i >= 0),
      ...specs.map((sp, i) => (i > 0 && !sp.ghost ? i : -1)).filter((i) => i >= 0),
    ];
    this.laneX = new Array(boatCount);
    priority.forEach((boatIdx, k) => (this.laneX[boatIdx] = x0 + order[k] * LANE_WIDTH));

    // 레인 경계 부표
    const lines = lanes + 1;
    const spacing = 10;
    const per = Math.ceil((distanceM + 100) / spacing);
    const buoyGeo = new THREE.SphereGeometry(0.28, 10, 8);
    const buoys = new THREE.InstancedMesh(buoyGeo, new THREE.MeshStandardMaterial({ roughness: 0.4 }), lines * per);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let k = 0;
    for (let li = 0; li < lines; li++) {
      const x = x0 - LANE_WIDTH / 2 + li * LANE_WIDTH;
      for (let i = 0; i < per; i++) {
        const d = i * spacing;
        m.makeTranslation(x, 0.1, -d);
        buoys.setMatrixAt(k, m);
        buoys.setColorAt(k, c.set(d % 250 === 0 ? '#ff3b30' : d > distanceM - 250 ? '#ff9500' : '#ffd60a'));
        k++;
      }
    }
    this.scene.add(buoys);

    // 거리 표지(250m마다)
    for (let d = 250; d < distanceM; d += 250) {
      const s = textSprite(`${d}m`, { size: 80, bg: 'rgba(255,255,255,0.9)', color: '#13203a', width: 320 });
      s.scale.set(7, 2.8, 1);
      s.position.set(x0 - LANE_WIDTH / 2 - 6, 3.2, -d);
      this.scene.add(s);
    }

    // 출발 폰툰은 카메라 앞을 가려서 두지 않는다.
  }

  private buildFinish(boatCount: number, distanceM: number): void {
    const lanes = Math.max(boatCount, 3);
    const span = lanes * LANE_WIDTH + 16;
    const g = new THREE.Group();
    g.position.z = -distanceM;
    const towerMat = new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.6 });
    for (const side of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(2, 14, 2), towerMat);
      t.position.set((side * span) / 2, 7, 0);
      t.castShadow = true;
      g.add(t);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(span, 3),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(1024, 96, (ctx) => {
          for (let i = 0; i < 64; i++) {
            ctx.fillStyle = i % 2 ? '#111' : '#fff';
            ctx.fillRect(i * 16, 0, 16, 48);
            ctx.fillStyle = i % 2 ? '#fff' : '#111';
            ctx.fillRect(i * 16, 48, 16, 48);
          }
          ctx.fillStyle = '#ff3b30';
          ctx.fillRect(352, 8, 320, 80);
          ctx.fillStyle = '#fff';
          ctx.font = '800 64px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('FINISH', 512, 50);
        }),
        side: THREE.DoubleSide,
      }),
    );
    banner.position.y = 13;
    g.add(banner);
    // 수면 결승선
    const line = new THREE.Mesh(new THREE.PlaneGeometry(span, 0.6), new THREE.MeshBasicMaterial({ color: '#ff3b30' }));
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.05;
    g.add(line);
    this.scene.add(g);
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
  }

  /** boats[0]은 플레이어. dt는 초. */
  render(boats: BoatRenderState[], dt: number): void {
    this.resize();
    this.clock += dt;
    const t = this.clock;

    boats.forEach((b, i) => {
      const boat = this.boats[i];
      if (!boat) return;
      boat.group.position.z = -b.distance;
      boat.pose(b.index, b.driving, t);
      const label = this.labels[i];
      if (label) label.position.set(this.laneX[i], 3.6, -b.distance);
    });

    // 카메라: 플레이어 보트 뒤쪽 위에서 따라간다.
    // 바로 뒤에 바짝 쫓아오는 상대가 있으면 카메라를 조금 뒤로 빼서 같이 보이게 한다(25m 안쪽만).
    // 더 멀리 떨어진 상대는 순위표와 진행 막대로 보여주고, 내 배가 작아지지 않게 한다.
    const p = this.boats[0]?.group.position ?? new THREE.Vector3();
    const me = boats[0]?.distance ?? 0;
    let behind = 0;
    for (const b of boats.slice(1)) {
      const gap = me - b.distance;
      if (gap > 0 && gap < 25) behind = Math.max(behind, gap);
    }
    const pull = Math.min(1, behind / 25) * 0.6;
    const want = new THREE.Vector3(p.x + 8 + pull * 6, 6 + pull * 9, p.z + 18 + behind * 0.9);
    const k = 1 - Math.exp(-dt * 2);
    this.camPos.lerp(want, k);
    this.camTarget.lerp(new THREE.Vector3(p.x - 2, 1.2, p.z - 25 + behind * 0.25), k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // 그림자 카메라도 플레이어 근처를 따라간다.
    this.sun.target.position.set(p.x, 0, p.z - 15);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 250);

    (this.water.material as THREE.ShaderMaterial).uniforms.time.value = t * 0.6;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
  }
}
