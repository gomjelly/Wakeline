// 스트로크 감지기 (FR-STK-01~03). 핸들 위치 지표(0 캐치 ~ 1 피니시)로 상태 머신을 돌린다.
// 리커버리 → 캐치(지표가 캐치 임계값 아래) → 드라이브(올라감) → 피니시(피니시 임계값 위) → 리커버리
// DOM에 의존하지 않아 녹화 좌표로 단위 테스트할 수 있다.

import type { DetectionConfig } from '../config';

export type StrokePhase = 'recovery' | 'catch' | 'drive';

export interface StrokeEvent {
  /** 피니시 시각(ms) */
  t: number;
  /** 정규화 스트로크 길이(0~1) = 피니시 최대 지표 - 캐치 최소 지표 */
  length: number;
  driveMs: number;
  recoveryMs: number;
  /** 직전 스트로크와의 간격으로 잰 순간 SPM (첫 스트로크는 드라이브+리커버리로 추정) */
  spm: number;
  /** 추정 파워(상대값) = 길이 / 드라이브 시간(초) */
  power: number;
}

export class StrokeDetector {
  phase: StrokePhase = 'recovery';
  private catchT = 0;
  private catchMin = 1;
  private finishMax = 0;
  private lastFinishT: number | null = null;
  private lastIndex: number | null = null;

  constructor(private cfg: DetectionConfig) {}

  reset(): void {
    this.phase = 'recovery';
    this.catchMin = 1;
    this.finishMax = 0;
    this.lastFinishT = null;
    this.lastIndex = null;
  }

  /** 지표가 나올 때마다 호출한다. 스트로크가 끝나면(피니시) 이벤트를 돌려준다. */
  update(t: number, index: number | null): StrokeEvent | null {
    if (index === null) return null;
    const { catchThreshold: c, finishThreshold: f, hysteresis: h } = this.cfg;
    let event: StrokeEvent | null = null;

    switch (this.phase) {
      case 'recovery':
        if (index <= c - h) {
          this.phase = 'catch';
          this.catchMin = index;
          this.catchT = t;
        }
        break;
      case 'catch':
        // 가장 깊이 들어간 지점을 캐치 시각으로 본다.
        if (index < this.catchMin) {
          this.catchMin = index;
          this.catchT = t;
        }
        if (index > c + h) {
          this.phase = 'drive';
          this.finishMax = index;
        }
        break;
      case 'drive':
        this.finishMax = Math.max(this.finishMax, index);
        if (index >= f + h) {
          const minGap = this.cfg.minStrokeIntervalMs;
          if (this.lastFinishT === null || t - this.lastFinishT >= minGap) {
            const driveMs = Math.max(1, t - this.catchT);
            const recoveryMs = this.lastFinishT === null ? driveMs * 2 : Math.max(0, this.catchT - this.lastFinishT);
            const cycle = this.lastFinishT === null ? driveMs + recoveryMs : t - this.lastFinishT;
            event = {
              t,
              length: Math.max(0, Math.min(1, this.finishMax - this.catchMin)),
              driveMs,
              recoveryMs,
              spm: 60000 / Math.max(1, cycle),
              power: (this.finishMax - this.catchMin) / (driveMs / 1000),
            };
            this.lastFinishT = t;
          }
          this.phase = 'recovery';
        } else if (index <= c - h) {
          // 끝까지 당기지 않고 다시 캐치로 돌아감 → 짧은 스트로크는 버린다.
          this.phase = 'catch';
          this.catchMin = index;
          this.catchT = t;
        }
        break;
    }
    this.lastIndex = index;
    return event;
  }

  get index(): number | null {
    return this.lastIndex;
  }
}
