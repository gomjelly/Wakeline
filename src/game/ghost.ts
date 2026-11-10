// 고스트 보트 (FR-REC-03, 04): 저장한 스트로크 타임라인 (시각, 누적 거리)을 시간 기준으로 재생한다.

export interface GhostSource {
  /** 화면·순위표에 보일 이름 (다른 배와 겹치지 않게 만든 값) */
  name: string;
  sessionId: string;
  /** (레이스 시각 ms, 누적 거리 m) — 시각 순 */
  timeline: { t: number; d: number }[];
  /** 그 기록이 완주했으면 완주 시각 */
  finishTimeMs: number | null;
  /** 기록에서 실제로 간 거리 */
  coveredM: number;
}

export class GhostBoat {
  distance = 0;
  index = 0.5;
  driving = false;
  finishTimeMs: number | null = null;
  private i = 0;

  constructor(
    readonly src: GhostSource,
    private raceDistance: number,
  ) {}

  step(elapsedMs: number): void {
    const tl = this.src.timeline;
    if (tl.length < 2) return;
    // 현재 구간 찾기 (시간은 앞으로만 흐른다)
    while (this.i < tl.length - 2 && tl[this.i + 1].t <= elapsedMs) this.i++;
    const a = tl[this.i], b = tl[this.i + 1];
    let d: number;
    if (elapsedMs >= tl[tl.length - 1].t) d = tl[tl.length - 1].d;
    else {
      const k = (elapsedMs - a.t) / Math.max(1, b.t - a.t);
      d = a.d + (b.d - a.d) * Math.max(0, Math.min(1, k));
    }
    this.distance = Math.min(d, this.raceDistance + 30);

    // 노 젓는 동작: 저장된 스트로크(피니시) 사이를 한 사이클로 보고 드라이브 1/3, 리커버리 2/3
    const span = Math.max(1, b.t - a.t);
    const p = Math.max(0, Math.min(1, (elapsedMs - a.t) / span));
    const moving = elapsedMs < tl[tl.length - 1].t && span < 6000;
    if (moving) {
      // 피니시(a) 직후는 리커버리, 끝 1/3이 드라이브
      this.driving = p > 2 / 3;
      this.index = this.driving ? ease((p - 2 / 3) * 3) : 1 - ease(p * 1.5);
    } else {
      this.driving = false;
      this.index += (0.5 - this.index) * 0.05;
    }

    if (this.finishTimeMs === null && this.src.finishTimeMs !== null && elapsedMs >= this.src.finishTimeMs) {
      this.finishTimeMs = this.src.finishTimeMs;
    }
  }
}

function ease(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** 저장된 기록으로 고스트 타임라인을 만든다. 출발점(0,0)과 결승 지점을 앞뒤에 붙인다. */
export function buildTimeline(
  strokes: { tMs: number; distanceM: number }[],
  totalTimeMs: number,
  coveredM: number,
): { t: number; d: number }[] {
  const tl = [{ t: 0, d: 0 }, ...strokes.map((s) => ({ t: s.tMs, d: s.distanceM }))];
  const last = tl[tl.length - 1];
  if (totalTimeMs > last.t && coveredM >= last.d) tl.push({ t: totalTimeMs, d: coveredM });
  return tl;
}
