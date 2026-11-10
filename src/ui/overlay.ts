// 카메라 영상 위에 골격을 그린다 (FR-CAM-03). 인식 상태 색: 초록/노랑/빨강 (FR-CAM-04).

import type { TrackStatus } from '../pose/handleIndex';
import { LM, type Landmark, type Side } from '../pose/landmarks';
import { POSE_CONNECTIONS } from '../pose/poseTracker';

export const STATUS_COLOR: Record<TrackStatus, string> = {
  ok: '#3ddc84',
  partial: '#ffc94d',
  none: '#ff5c5c',
};

export class SkeletonOverlay {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(): { w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  draw(lms: Landmark[] | null, status: TrackStatus, side: Side, minVisibility: number): void {
    const { w, h } = this.fit();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const color = STATUS_COLOR[status];

    // 상태 테두리
    ctx.lineWidth = Math.max(4, w * 0.006);
    ctx.strokeStyle = color;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

    if (!lms) return;

    const px = (l: Landmark) => [l.x * w, l.y * h] as const;
    const scale = w / 640;

    // 연결선
    ctx.lineWidth = 3 * scale;
    ctx.lineCap = 'round';
    for (const { start, end } of POSE_CONNECTIONS) {
      const a = lms[start], b = lms[end];
      if (!a || !b) continue;
      const v = Math.min(a.visibility ?? 0, b.visibility ?? 0);
      ctx.globalAlpha = v >= minVisibility ? 0.9 : 0.25;
      ctx.strokeStyle = color;
      const [ax, ay] = px(a);
      const [bx, by] = px(b);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // 관절 점
    ctx.globalAlpha = 1;
    for (const l of lms) {
      if ((l.visibility ?? 0) < minVisibility) continue;
      const [x, y] = px(l);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, 3 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    // 지표 계산에 쓰는 관절 강조: 손목(핸들), 엉덩이, 어깨
    const p = LM[side];
    const wrist = lms[p.wrist], hip = lms[p.hip], shoulder = lms[p.shoulder];
    const mark = (l: Landmark, c: string) => {
      const [x, y] = px(l);
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, 8 * scale, 0, Math.PI * 2);
      ctx.fill();
    };
    mark(shoulder, '#7aa2ff');
    mark(hip, '#7aa2ff');
    mark(wrist, '#38e1ff');

    // 손목-엉덩이 수평 거리 표시
    const [wx, wy] = px(wrist);
    const [hx, hy] = px(hip);
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.strokeStyle = '#38e1ff';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(wx, wy);
    ctx.lineTo(hx, wy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
