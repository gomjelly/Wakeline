// 핸들 위치 지표 계산. DOM에 의존하지 않는 순수 로직이라 녹화한 좌표로 단위 테스트할 수 있다(NFR-07).
//
// raw  = |손목.x - 엉덩이.x| / 몸통 길이(어깨~엉덩이)   (픽셀 기준, 화면 비율 보정)
//        캐치(팔을 앞으로 뻗음)일 때 크고, 피니시(핸들을 가슴까지 당김)일 때 작다.
// index = raw를 최근 범위로 0~1 정규화한 뒤 뒤집은 값. 캐치 ≈ 0, 피니시 ≈ 1 (SRS 3.2의 임계값 방향과 맞춤).

import type { DetectionConfig } from '../config';
import { KEY_JOINTS, LM, type Landmark, type Side } from './landmarks';

export type TrackStatus = 'ok' | 'partial' | 'none';

export interface PoseMetrics {
  status: TrackStatus;
  side: Side;
  /** 정규화 전 손목-엉덩이 수평 거리 / 몸통 길이 */
  raw: number | null;
  /** 지수 이동평균으로 평활화한 raw */
  smoothed: number | null;
  /** 0(캐치) ~ 1(피니시) */
  index: number | null;
  /** 엉덩이-무릎-발목 각도(도). 다리를 펴면 180에 가까움 */
  kneeAngleDeg: number | null;
}

function vis(l: Landmark | undefined): number {
  return l?.visibility ?? 0;
}

function sideVisibility(lms: Landmark[], side: Side): number {
  return KEY_JOINTS.reduce((sum, j) => sum + vis(lms[LM[side][j]]), 0);
}

function angleDeg(a: Landmark, b: Landmark, c: Landmark, aspect: number): number {
  const abx = (a.x - b.x) * aspect, aby = a.y - b.y;
  const cbx = (c.x - b.x) * aspect, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const m = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (m === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

export class HandleIndexTracker {
  private sideBias = 0; // >0 왼쪽이 더 잘 보임
  private currentSide: Side = 'left';
  private smoothed: number | null = null;
  private history: { t: number; v: number }[] = [];

  constructor(
    private cfg: DetectionConfig,
    /** 정규화 범위를 잡는 최근 구간 길이 */
    private windowMs = 8000,
  ) {
    if (cfg.side !== 'auto') this.currentSide = cfg.side;
  }

  reset(): void {
    this.smoothed = null;
    this.history = [];
  }

  /**
   * @param lms 한 사람의 33개 관절 (없으면 null)
   * @param aspect 영상 너비/높이
   * @param tMs 프레임 시각
   */
  update(lms: Landmark[] | null, aspect: number, tMs: number): PoseMetrics {
    if (!lms || lms.length < 33) {
      return { status: 'none', side: this.currentSide, raw: null, smoothed: this.smoothed, index: null, kneeAngleDeg: null };
    }

    const side = this.pickSide(lms);
    const p = LM[side];
    const shoulder = lms[p.shoulder], wrist = lms[p.wrist], hip = lms[p.hip];
    const knee = lms[p.knee], ankle = lms[p.ankle];

    const minVis = this.cfg.minVisibility;
    const visible = KEY_JOINTS.filter((j) => vis(lms[p[j]]) >= minVis).length;
    const status: TrackStatus = visible === KEY_JOINTS.length ? 'ok' : visible >= 2 ? 'partial' : 'none';

    const coreVisible = vis(shoulder) >= minVis && vis(wrist) >= minVis && vis(hip) >= minVis;
    let raw: number | null = null;
    if (coreVisible) {
      const torso = Math.hypot((shoulder.x - hip.x) * aspect, shoulder.y - hip.y);
      if (torso > 1e-4) raw = (Math.abs(wrist.x - hip.x) * aspect) / torso;
    }

    const kneeAngleDeg =
      vis(hip) >= minVis && vis(knee) >= minVis && vis(ankle) >= minVis ? angleDeg(hip, knee, ankle, aspect) : null;

    let index: number | null = null;
    if (raw !== null) {
      const a = this.cfg.smoothingAlpha;
      this.smoothed = this.smoothed === null ? raw : a * raw + (1 - a) * this.smoothed;
      this.history.push({ t: tMs, v: this.smoothed });
      while (this.history.length && this.history[0].t < tMs - this.windowMs) this.history.shift();

      let min = Infinity, max = -Infinity;
      for (const h of this.history) {
        if (h.v < min) min = h.v;
        if (h.v > max) max = h.v;
      }
      const span = max - min;
      // 범위가 너무 좁으면(가만히 있을 때) 정규화하지 않는다.
      if (span > 0.15) index = 1 - (this.smoothed - min) / span;
    }

    return { status, side, raw, smoothed: this.smoothed, index, kneeAngleDeg };
  }

  private pickSide(lms: Landmark[]): Side {
    if (this.cfg.side !== 'auto') return this.cfg.side;
    const diff = sideVisibility(lms, 'left') - sideVisibility(lms, 'right');
    this.sideBias = 0.9 * this.sideBias + 0.1 * diff;
    // 히스테리시스: 확실히 반대쪽이 잘 보일 때만 바꾼다.
    if (this.currentSide === 'left' && this.sideBias < -0.5) this.currentSide = 'right';
    else if (this.currentSide === 'right' && this.sideBias > 0.5) this.currentSide = 'left';
    return this.currentSide;
  }
}
