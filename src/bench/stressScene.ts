// 부하 테스트용 3D 장면. 실제 게임처럼 GPU를 쓰는 상태에서 자세 인식 속도가 얼마나 떨어지는지 확인한다.
// 물결 셰이더 평면 + 그림자 + 오브젝트 여러 개로 대략 한강 레이스 장면 수준의 부하를 만든다.

import * as THREE from 'three';

export class StressScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private water: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private boats: THREE.Object3D[] = [];
  private t0 = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = new THREE.Color('#f5a46b');
    this.scene.fog = new THREE.Fog('#f5a46b', 60, 260);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
    this.camera.position.set(0, 6, 14);
    this.camera.lookAt(0, 0, -20);

    this.scene.add(new THREE.HemisphereLight('#ffd6a8', '#1b2a4a', 0.8));
    const sun = new THREE.DirectionalLight('#ffe0b0', 2.2);
    sun.position.set(-30, 40, -20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    this.scene.add(sun);

    const waterMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying float vH;
        varying vec3 vPos;
        void main() {
          vec3 p = position;
          float h = 0.0;
          for (int i = 1; i <= 6; i++) {
            float f = float(i);
            h += sin(p.x * 0.15 * f + uTime * (0.6 + f * 0.2)) * cos(p.y * 0.11 * f - uTime * 0.7) * (0.35 / f);
          }
          p.z += h;
          vH = h;
          vPos = (modelMatrix * vec4(p, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vH;
        varying vec3 vPos;
        void main() {
          vec3 deep = vec3(0.05, 0.18, 0.32);
          vec3 shallow = vec3(0.35, 0.55, 0.65);
          vec3 c = mix(deep, shallow, clamp(vH * 1.5 + 0.5, 0.0, 1.0));
          float sparkle = pow(max(0.0, sin(vPos.x * 3.0) * sin(vPos.z * 2.7)), 24.0);
          c += vec3(1.0, 0.8, 0.5) * sparkle * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 400, 400), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.scene.add(this.water);

    // 강변 건물(빌딩 숲) + 보트
    const bMat = new THREE.MeshStandardMaterial({ color: '#4b5874', roughness: 0.8 });
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 400; i++) {
      const b = new THREE.Mesh(bGeo, bMat);
      const sideX = (i % 2 === 0 ? -1 : 1) * (40 + Math.random() * 40);
      const hgt = 5 + Math.random() * 40;
      b.scale.set(4 + Math.random() * 6, hgt, 4 + Math.random() * 6);
      b.position.set(sideX, hgt / 2, -Math.random() * 400 + 50);
      b.castShadow = true;
      b.receiveShadow = true;
      this.scene.add(b);
    }
    const hullMat = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.4 });
    for (let i = 0; i < 4; i++) {
      const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 7, 8, 16), hullMat);
      hull.rotation.x = Math.PI / 2;
      hull.position.set((i - 1.5) * 4, 0.4, -10 - i * 3);
      hull.castShadow = true;
      this.scene.add(hull);
      this.boats.push(hull);
    }
  }

  render(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
    const t = (performance.now() - this.t0) / 1000;
    this.water.material.uniforms.uTime.value = t;
    this.boats.forEach((b, i) => {
      b.position.z = -10 - i * 3 - ((t * (3 + i * 0.4)) % 120);
      b.position.y = 0.4 + Math.sin(t * 2 + i) * 0.08;
    });
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
