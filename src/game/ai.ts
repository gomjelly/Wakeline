// AI 상대 보트 (FR-AI-01~03). 일정 속도가 아니라 스트로크 단위로 가속·감속하고 페이스가 조금씩 흔들린다.

import type { DifficultyConfig } from '../config';

/** 시드가 같으면 같은 레이스가 나오는 난수 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AiBoat {
  distance = 0;
  speed = 0;
  strokes = 0;
  finishTimeMs: number | null = null;
  /** 0(캐치)~1(피니시). 노 젓는 애니메이션용 */
  index = 0;
  driving = false;

  private rand: () => number;
  private baseSpeed: number;
  private paceFactor = 1;
  private spm: number;
  private cyclePos = 0; // 0~1, 한 스트로크 안의 위치

  constructor(
    private diff: DifficultyConfig,
    splitSec: number,
    private raceDistance: number,
    seed: number,
  ) {
    this.rand = mulberry32(seed);
    this.baseSpeed = 500 / splitSec;
    this.spm = this.pickSpm();
    this.cyclePos = this.rand();
    this.speed = 0;
  }

  private pickSpm(): number {
    const [lo, hi] = this.diff.spm;
    return lo + (hi - lo) * this.rand();
  }

  step(dt: number, elapsedMs: number): void {
    if (this.finishTimeMs !== null) {
      this.speed *= Math.max(0, 1 - dt * 0.6);
      this.distance += this.speed * dt;
      this.index += (0.5 - this.index) * Math.min(1, dt * 2);
      this.driving = false;
      return;
    }

    this.cyclePos += (this.spm / 60) * dt;
    if (this.cyclePos >= 1) {
      // 새 스트로크: 페이스를 조금 흔든다(평균 1로 되돌아가는 랜덤워크).
      this.cyclePos -= 1;
      this.strokes++;
      const v = this.diff.paceVariance;
      this.paceFactor += (1 - this.paceFactor) * 0.3 + (this.rand() * 2 - 1) * v * 0.6;
      this.paceFactor = Math.max(1 - v, Math.min(1 + v, this.paceFactor));
      this.spm = this.spm * 0.7 + this.pickSpm() * 0.3;
    }

    // 드라이브 1/3, 리커버리 2/3
    const p = this.cyclePos;
    this.driving = p < 1 / 3;
    this.index = this.driving ? smooth(p * 3) : 1 - smooth((p - 1 / 3) * 1.5);

    // 마지막 20% 구간 막판 스퍼트
    const sprint = this.distance > this.raceDistance * 0.8 ? 1 + this.diff.finalSprint : 1;
    // 드라이브 때 빨라지고 리커버리 때 느려진다(평균은 목표 속도)
    const surge = this.driving ? 1.18 : 0.91;
    const target = this.baseSpeed * this.paceFactor * sprint * surge;
    // 출발할 때는 몇 스트로크에 걸쳐 속도를 올린다.
    this.speed += (target - this.speed) * Math.min(1, dt * 2.2);
    this.distance += this.speed * dt;

    if (this.distance >= this.raceDistance) {
      // 마지막 프레임의 넘친 거리만큼 시간을 보정한다.
      const over = (this.distance - this.raceDistance) / Math.max(0.1, this.speed);
      this.finishTimeMs = elapsedMs - over * 1000;
    }
  }
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
