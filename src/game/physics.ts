// 플레이어 보트 물리 (FR-MOV-01, 02, 04).
// 드라이브 중 핸들 지표가 올라가는 속도만큼 추진력을 주고, 늘 속도에 비례한 저항으로 감속한다.
//   dv/dt = propulsionGain × max(0, d지표/dt) − dragCoefficient × v
// 한 스트로크 동안 받는 힘의 합 = 계수 × 스트로크 길이 이므로 "계수 × 길이 × 드라이브 속도"와 같은 꼴이 된다.
// 지표가 들어오는 즉시 힘을 주기 때문에 피니시를 기다리지 않아 지연이 작다.

import type { PhysicsConfig } from '../config';

/** 이 값보다 느린 지표 상승은 잡음으로 보고 무시한다(1/s). */
const DEAD_ZONE = 0.25;
/** 지표가 이 시간(ms) 넘게 안 들어오면 추진을 멈춘다. */
const STALE_MS = 150;

export class BoatPhysics {
  distance = 0;
  speed = 0;
  private driveRate = 0;
  private lastIndex: number | null = null;
  private lastIndexT = 0;
  private lastInputT = -Infinity;

  constructor(private cfg: PhysicsConfig) {}

  reset(): void {
    this.distance = 0;
    this.speed = 0;
    this.driveRate = 0;
    this.lastIndex = null;
    this.lastInputT = -Infinity;
  }

  /** 자세 인식 결과마다 호출. t는 ms. */
  input(t: number, index: number | null): void {
    if (index === null) {
      this.lastIndex = null;
      this.driveRate = 0;
      return;
    }
    if (this.lastIndex !== null && t > this.lastIndexT) {
      const rate = (index - this.lastIndex) / ((t - this.lastIndexT) / 1000);
      this.driveRate = rate > DEAD_ZONE ? Math.min(rate, 6) : 0;
    }
    this.lastIndex = index;
    this.lastIndexT = t;
    this.lastInputT = t;
  }

  /**
   * @param dt 초
   * @param now ms (input과 같은 시계)
   * @param propel false면 추진력을 주지 않는다(카운트다운 중)
   */
  step(dt: number, now: number, propel: boolean): void {
    const fresh = now - this.lastInputT <= STALE_MS;
    const force = propel && fresh ? this.cfg.propulsionGain * this.driveRate : 0;
    this.speed += (force - this.cfg.dragCoefficient * this.speed) * dt;
    this.speed = Math.max(0, Math.min(this.cfg.maxSpeedMps, this.speed));
    this.distance += this.speed * dt;
  }
}
