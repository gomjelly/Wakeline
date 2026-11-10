// 관절 좌표 녹화 → JSON 저장. 2단계 스트로크 감지기 튜닝·단위 테스트용 데이터. 영상은 저장하지 않는다(NFR-04).

import type { Landmark } from './landmarks';

export interface PoseRecording {
  version: 1;
  recordedAt: string;
  width: number;
  height: number;
  model: string;
  /** 'camera' 또는 'file:<파일명>' */
  source: string;
  /** [t(ms, 녹화 시작 기준), 관절 33개 × [x, y, z, visibility]] 또는 사람 없음이면 null */
  frames: [number, number[][] | null][];
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

export class PoseRecorder {
  private frames: PoseRecording['frames'] = [];
  private t0 = 0;
  private meta = { width: 0, height: 0, model: '', source: '' };
  recording = false;

  get frameCount(): number {
    return this.frames.length;
  }

  get durationMs(): number {
    return this.frames.length ? this.frames[this.frames.length - 1][0] : 0;
  }

  /** @param t0 기록 시각의 기준점. 동영상 입력이면 영상 시계 값을 넘긴다. */
  start(width: number, height: number, model: string, source: string, t0 = performance.now()): void {
    this.frames = [];
    this.t0 = t0;
    this.meta = { width, height, model, source };
    this.recording = true;
  }

  push(tMs: number, lms: Landmark[] | null): void {
    if (!this.recording) return;
    const pts = lms ? lms.map((l) => [r4(l.x), r4(l.y), r4(l.z), r4(l.visibility ?? 0)]) : null;
    this.frames.push([Math.round(tMs - this.t0), pts]);
  }

  stop(): PoseRecording {
    this.recording = false;
    return { version: 1, recordedAt: new Date().toISOString(), ...this.meta, frames: this.frames };
  }
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
