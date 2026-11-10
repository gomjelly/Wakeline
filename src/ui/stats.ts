// 성능 측정: 카메라 fps, 인식 fps, 추론 시간(평균/95%), 렌더 fps.

export class RateCounter {
  private times: number[] = [];
  constructor(private windowMs = 2000) {}

  tick(t = performance.now()): void {
    this.times.push(t);
    this.trim(t);
  }

  rate(t = performance.now()): number {
    this.trim(t);
    if (this.times.length < 2) return 0;
    return ((this.times.length - 1) * 1000) / (this.times[this.times.length - 1] - this.times[0]);
  }

  private trim(t: number): void {
    while (this.times.length && this.times[0] < t - this.windowMs) this.times.shift();
  }
}

export class DurationStats {
  private values: number[] = [];
  constructor(private max = 120) {}

  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.max) this.values.shift();
  }

  reset(): void {
    this.values = [];
  }

  get mean(): number {
    return this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : 0;
  }

  get p95(): number {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
}

export type Grade = 'good' | 'warn' | 'bad';

/** SRS NFR-01 기준: 인식 25fps 이상, 렌더 50fps 이상 */
export function gradeFps(fps: number, target: number): Grade {
  if (fps >= target) return 'good';
  if (fps >= target * 0.6) return 'warn';
  return 'bad';
}
