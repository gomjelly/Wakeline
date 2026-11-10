// 1인승 스컬 보트 + 노 젓는 사람 모델 (FR-MOV-03).
// 지표(0 캐치 ~ 1 피니시)를 넣으면 다리 → 몸통 → 팔 순서로 움직이고 노가 물을 긁는다.
// 좌표: 1 = 1m. 뱃머리는 -Z 방향, 사람은 선미(+Z)를 보고 앉는다.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** a와 b 사이를 잇는 원기둥(팔다리) */
class Limb {
  readonly mesh: THREE.Mesh;
  private static geo = new THREE.CylinderGeometry(1, 1, 1, 10);
  constructor(material: THREE.Material, private radius: number) {
    this.mesh = new THREE.Mesh(Limb.geo, material);
    this.mesh.castShadow = true;
  }
  set(a: THREE.Vector3, b: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    this.mesh.position.copy(a).addScaledVector(dir, 0.5);
    this.mesh.scale.set(this.radius, len, this.radius);
    this.mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  }
}

/** 두 마디 IK: 시작점 a, 끝점 c, 마디 길이 l1/l2, 구부러지는 방향 bend */
function solveJoint(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, bend: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(a.distanceTo(c), l1 + l2 - 1e-3);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const axis = new THREE.Vector3().subVectors(c, a).normalize();
  const perp = bend.clone().addScaledVector(axis, -bend.dot(axis)).normalize();
  return a.clone().addScaledVector(axis, x).addScaledVector(perp, h);
}

export interface RowerColors {
  hull: string;
  jersey: string;
  skin?: string;
  blade: string;
}

export class RowingBoat {
  readonly group = new THREE.Group();
  private rower = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private limbs: Record<string, Limb> = {};
  private oars: { shaft: Limb; blade: THREE.Mesh; side: 1 | -1 }[] = [];
  private seat: THREE.Mesh;
  private bob = Math.random() * 10;

  constructor(colors: RowerColors) {
    const hullMat = new THREE.MeshStandardMaterial({ color: colors.hull, roughness: 0.35, metalness: 0.1 });
    const deckMat = new THREE.MeshStandardMaterial({ color: '#2a2f3a', roughness: 0.6 });
    const metal = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.3, metalness: 0.8 });
    const jersey = new THREE.MeshStandardMaterial({ color: colors.jersey, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: colors.skin ?? '#e0b08a', roughness: 0.8 });
    const shorts = new THREE.MeshStandardMaterial({ color: '#1d2230', roughness: 0.8 });
    const bladeMat = new THREE.MeshStandardMaterial({ color: colors.blade, roughness: 0.5, side: THREE.DoubleSide });
    const shaftMat = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.4 });

    // 선체: 길고 가는 몸통(8m)
    const hullGeo = new THREE.SphereGeometry(1, 32, 12);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.scale.set(0.24, 0.13, 4.0);
    hull.position.y = 0.02;
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.group.add(hull);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 1.6), deckMat);
    deck.position.set(0, 0.13, 0.1);
    this.group.add(deck);

    // 리거(노걸이)
    for (const side of [1, -1] as const) {
      const rig = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.025, 0.03), metal);
      rig.position.set(side * 0.47, 0.32, -0.05);
      rig.rotation.z = side * -0.25;
      this.group.add(rig);
    }

    // 시트
    this.seat = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.24), deckMat);
    this.seat.position.y = 0.2;
    this.group.add(this.seat);

    // 사람
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.36, 4, 10), jersey);
    this.torso.castShadow = true;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), skin);
    this.head.castShadow = true;
    this.rower.add(this.torso, this.head);
    for (const side of ['l', 'r']) {
      this.limbs[`thigh${side}`] = new Limb(shorts, 0.075);
      this.limbs[`shin${side}`] = new Limb(skin, 0.055);
      this.limbs[`upper${side}`] = new Limb(jersey, 0.05);
      this.limbs[`fore${side}`] = new Limb(skin, 0.04);
    }
    for (const l of Object.values(this.limbs)) this.rower.add(l.mesh);
    this.group.add(this.rower);

    // 노 2개
    for (const side of [1, -1] as const) {
      const shaft = new Limb(shaftMat, 0.018);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.5), bladeMat);
      blade.castShadow = true;
      this.group.add(shaft.mesh, blade);
      this.oars.push({ shaft, blade, side });
    }

    this.pose(0.5, false, 0);
  }

  /**
   * @param index 0(캐치) ~ 1(피니시)
   * @param driving 드라이브 중이면 노가 물속, 아니면 물 위
   */
  pose(index: number, driving: boolean, time: number): void {
    const t = Math.max(0, Math.min(1, index));
    // 드라이브는 다리 → 몸통 → 팔 순서
    const legs = smoothstep(0, 0.65, t);
    const body = smoothstep(0.25, 0.85, t);
    const arms = smoothstep(0.55, 1, t);

    // 앞뒤로 살짝 흔들림
    this.group.position.y = Math.sin(time * 1.7 + this.bob) * 0.02;
    this.group.rotation.x = Math.sin(time * 1.3 + this.bob) * 0.004;

    const seatZ = THREE.MathUtils.lerp(0.42, -0.2, legs);
    this.seat.position.z = seatZ;
    const hip = new THREE.Vector3(0, 0.3, seatZ);

    // 몸통: 캐치 때 선미 쪽(+Z)으로 숙이고, 피니시 때 뱃머리 쪽으로 젖힌다.
    const lean = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(28, -22, body));
    const torsoDir = new THREE.Vector3(0, Math.cos(lean), Math.sin(lean));
    const shoulder = hip.clone().addScaledVector(torsoDir, 0.55);
    this.torso.position.copy(hip).addScaledVector(torsoDir, 0.3);
    this.torso.quaternion.setFromUnitVectors(UP, torsoDir);
    this.head.position.copy(hip).addScaledVector(torsoDir, 0.72);

    // 손(핸들): 캐치 때 앞으로 쭉 뻗고, 피니시 때 가슴까지 당긴다.
    const reach = THREE.MathUtils.lerp(0.62, 0.18, arms);
    // 손을 올리면(드라이브) 날이 물에 잠기고, 내리면(리커버리) 날이 물 위로 뜬다.
    const handY = shoulder.y - 0.16 + (driving ? 0 : -0.2);

    for (const [k, side] of [['l', -1], ['r', 1]] as const) {
      const ankle = new THREE.Vector3(side * 0.1, 0.2, 0.95);
      const hipS = hip.clone().setX(side * 0.1);
      const knee = solveJoint(hipS, ankle, 0.46, 0.46, new THREE.Vector3(side * 0.15, 1, 0));
      this.limbs[`thigh${k}`].set(hipS, knee);
      this.limbs[`shin${k}`].set(knee, ankle);

      const sh = shoulder.clone().setX(side * 0.18);
      const hand = new THREE.Vector3(side * 0.2, handY, shoulder.z + reach);
      const elbow = solveJoint(sh, hand, 0.3, 0.3, new THREE.Vector3(side, -0.6, -0.3));
      this.limbs[`upper${k}`].set(sh, elbow);
      this.limbs[`fore${k}`].set(elbow, hand);
    }

    // 노: 손잡이 → 노걸이(핀) → 날
    for (const oar of this.oars) {
      const handle = new THREE.Vector3(oar.side * 0.2, handY, shoulder.z + reach);
      const pin = new THREE.Vector3(oar.side * 0.82, 0.32, -0.05);
      const dir = new THREE.Vector3().subVectors(pin, handle).normalize();
      const tip = pin.clone().addScaledVector(dir, 2.0);
      oar.shaft.set(handle, tip);
      oar.blade.position.copy(tip);
      // 날의 길이 방향(로컬 Z)을 노 방향에 맞춘다.
      oar.blade.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().negate(), UP),
      );
      // 드라이브 때 날을 세워 물을 잡고, 리커버리 때 눕힌다(페더링).
      oar.blade.rotateZ(driving ? 0 : Math.PI / 2.2);
    }
  }
}
