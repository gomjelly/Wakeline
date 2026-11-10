// 핸들 위치 지표의 실시간 파형 그래프 (FR-STK-05, 1단계 완료 기준 확인용).

export interface GraphSample {
  t: number;
  index: number | null; // 0(캐치)~1(피니시)
  knee: number | null; // 무릎 각도(도)
}

export class IndexGraph {
  private ctx: CanvasRenderingContext2D;
  private samples: GraphSample[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private windowMs = 10000,
    public catchThreshold = 0.25,
    public finishThreshold = 0.75,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  push(s: GraphSample): void {
    this.samples.push(s);
    const cutoff = s.t - this.windowMs - 500;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  draw(now: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const pad = 8 * dpr;
    const x = (t: number) => w - ((now - t) / this.windowMs) * w;
    const y = (v: number) => pad + (1 - v) * (h - pad * 2);

    // 1초 격자
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let t = Math.ceil((now - this.windowMs) / 1000) * 1000; t <= now; t += 1000) {
      ctx.beginPath();
      ctx.moveTo(x(t), 0);
      ctx.lineTo(x(t), h);
      ctx.stroke();
    }

    // 캐치/피니시 임계값
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const [v, label] of [
      [this.catchThreshold, '캐치'],
      [this.finishThreshold, '피니시'],
    ] as const) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(0, y(v));
      ctx.lineTo(w, y(v));
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(label, 6 * dpr, y(v) - 4 * dpr);
    }
    ctx.setLineDash([]);

    // 무릎 각도 (보조, 60°~180° → 0~1)
    this.line((s) => (s.knee === null ? null : Math.max(0, Math.min(1, (s.knee - 60) / 120))), '#ff9f43', 1.5 * dpr, 0.55, x, y);
    // 핸들 위치 지표 (주)
    this.line((s) => s.index, '#38e1ff', 3 * dpr, 1, x, y);
  }

  private line(
    pick: (s: GraphSample) => number | null,
    color: string,
    width: number,
    alpha: number,
    x: (t: number) => number,
    y: (v: number) => number,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const s of this.samples) {
      const v = pick(s);
      if (v === null) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(s.t), y(v));
      else ctx.moveTo(x(s.t), y(v));
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
