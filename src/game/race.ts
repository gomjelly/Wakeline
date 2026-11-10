// 레이스 진행 (FR-GAM-03~07): 카운트다운 → 레이스 → (일시정지 ↔ 재개 카운트다운) → 결과.
// 렌더링과 분리된 순수 로직이다.

import type { DifficultyId, GameConfig } from '../config';
import { AiBoat } from './ai';
import { BoatPhysics } from './physics';
import { StrokeDetector, type StrokeEvent } from './strokeDetector';

export type RacePhase = 'countdown' | 'racing' | 'paused' | 'resume' | 'finished' | 'aborted';
export type OpponentKind = 'ai' | 'none';

export interface RaceSettings {
  mapId: string;
  distanceM: number;
  difficulty: DifficultyId;
  opponent: OpponentKind;
}

export interface RaceStroke extends StrokeEvent {
  index: number;
  /** 레이스 시작 기준 시각(ms, 일시정지 제외) */
  tRace: number;
  distanceM: number;
}

export interface BoatStanding {
  id: string; // 'player' | 'ai-0' ...
  name: string;
  distance: number;
  finishTimeMs: number | null;
}

export interface RaceSummary {
  status: 'finished' | 'aborted';
  totalTimeMs: number;
  distanceM: number;
  avgSplitSec: number;
  avgSpm: number;
  strokeCount: number;
  rank: number;
  boats: number;
  caloriesKcal: number;
}

const AI_NAMES = ['김한강', '이반포', '박동작', '최잠실', '정마포'];

export class Race {
  phase: RacePhase = 'countdown';
  /** 레이스 경과 시간(일시정지·카운트다운 제외) */
  elapsedMs = 0;
  /** 남은 카운트다운(ms) */
  countdownMs: number;
  finishTimeMs: number | null = null;

  readonly player: BoatPhysics;
  readonly detector: StrokeDetector;
  readonly ais: AiBoat[] = [];
  readonly strokes: RaceStroke[] = [];
  /** 플레이어 노 젓는 애니메이션용 지표(0~1) */
  playerIndex = 0.5;
  playerDriving = false;

  private history: { t: number; d: number }[] = [];
  private lastIndexForAnim: number | null = null;

  constructor(
    private cfg: GameConfig,
    readonly settings: RaceSettings,
  ) {
    this.player = new BoatPhysics(cfg.physics);
    this.detector = new StrokeDetector(cfg.detection);
    this.countdownMs = cfg.race.countdownSec * 1000;

    if (settings.opponent === 'ai') {
      const diff = cfg.difficulty[settings.difficulty];
      const n = Math.max(1, cfg.ai.count);
      for (let i = 0; i < n; i++) {
        // 목표 스플릿을 중심으로 고르게 벌려 놓는다. 예: 3척, 6초 → -6, 0, +6
        const offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * cfg.ai.spreadSec;
        this.ais.push(new AiBoat(diff, diff.splitSec + offset, settings.distanceM, 1000 + i * 7919 + Date.now() % 1000));
      }
    }
  }

  aiName(i: number): string {
    return AI_NAMES[i % AI_NAMES.length];
  }

  get running(): boolean {
    return this.phase === 'racing';
  }

  /** 자세 인식 결과마다 호출. t는 performance.now() 기준 ms. */
  onPose(t: number, index: number | null): void {
    this.player.input(t, index);
    const ev = this.detector.update(t, index);
    if (index !== null) {
      this.playerIndex = index;
      if (this.lastIndexForAnim !== null) this.playerDriving = index > this.lastIndexForAnim + 0.004;
      this.lastIndexForAnim = index;
    }
    // 카운트다운 중 스트로크는 기록·거리에 넣지 않는다(FR-GAM-03).
    if (ev && this.phase === 'racing') {
      this.strokes.push({ ...ev, index: this.strokes.length + 1, tRace: this.elapsedMs, distanceM: this.player.distance });
    }
  }

  tick(dt: number, now: number): void {
    switch (this.phase) {
      case 'countdown':
      case 'resume':
        this.countdownMs -= dt * 1000;
        this.player.step(dt, now, false);
        if (this.countdownMs <= 0) {
          this.phase = 'racing';
          this.countdownMs = 0;
        }
        break;
      case 'racing': {
        this.elapsedMs += dt * 1000;
        this.player.step(dt, now, true);
        for (const ai of this.ais) ai.step(dt, this.elapsedMs);
        this.history.push({ t: this.elapsedMs, d: this.player.distance });
        while (this.history.length && this.history[0].t < this.elapsedMs - 6000) this.history.shift();
        if (this.player.distance >= this.settings.distanceM) {
          const over = (this.player.distance - this.settings.distanceM) / Math.max(0.1, this.player.speed);
          this.finishTimeMs = this.elapsedMs - over * 1000;
          this.phase = 'finished';
        }
        break;
      }
      case 'finished':
      case 'aborted':
        // 결과 화면 뒤에서도 배들이 자연스럽게 미끄러지도록 계속 움직인다.
        this.elapsedMs += dt * 1000;
        this.player.step(dt, now, false);
        for (const ai of this.ais) ai.step(dt, this.elapsedMs);
        break;
      case 'paused':
        break;
    }
  }

  pause(): void {
    if (this.phase === 'racing' || this.phase === 'resume' || this.phase === 'countdown') {
      this.phase = 'paused';
    }
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'resume';
    this.countdownMs = this.cfg.race.resumeCountdownSec * 1000;
  }

  abort(): void {
    if (this.phase === 'finished' || this.phase === 'aborted') return;
    this.phase = 'aborted';
  }

  /** 최근 몇 초 평균 속도로 잰 500m 예상 시간(초) */
  get splitSec(): number | null {
    const h = this.history;
    if (h.length < 2) return null;
    const dt = (h[h.length - 1].t - h[0].t) / 1000;
    const dd = h[h.length - 1].d - h[0].d;
    if (dt < 1 || dd < 0.5) return null;
    return 500 / (dd / dt);
  }

  /** 최근 스트로크 3개의 평균 SPM. 6초 넘게 안 저으면 0 */
  get spm(): number {
    const s = this.strokes;
    if (!s.length || this.elapsedMs - s[s.length - 1].tRace > 6000) return 0;
    const recent = s.slice(-3);
    return recent.reduce((a, b) => a + b.spm, 0) / recent.length;
  }

  standings(): BoatStanding[] {
    const boats: BoatStanding[] = [
      { id: 'player', name: '나', distance: this.player.distance, finishTimeMs: this.finishTimeMs },
      ...this.ais.map((a, i) => ({ id: `ai-${i}`, name: this.aiName(i), distance: a.distance, finishTimeMs: a.finishTimeMs })),
    ];
    return boats.sort((a, b) => {
      if (a.finishTimeMs !== null && b.finishTimeMs !== null) return a.finishTimeMs - b.finishTimeMs;
      if (a.finishTimeMs !== null) return -1;
      if (b.finishTimeMs !== null) return 1;
      return b.distance - a.distance;
    });
  }

  summary(): RaceSummary {
    const finished = this.phase === 'finished';
    const time = finished && this.finishTimeMs !== null ? this.finishTimeMs : this.elapsedMs;
    const dist = Math.min(this.player.distance, this.settings.distanceM);
    const standings = this.standings();
    const minutes = time / 60000;
    // 대략적인 로잉 칼로리: 약 7 MET 기준
    const kcal = 7 * this.cfg.user.weightKg * (time / 3600000);
    return {
      status: finished ? 'finished' : 'aborted',
      totalTimeMs: time,
      distanceM: dist,
      avgSplitSec: dist > 0 ? (time / 1000) * (500 / dist) : 0,
      avgSpm: minutes > 0 ? this.strokes.length / minutes : 0,
      strokeCount: this.strokes.length,
      rank: standings.findIndex((b) => b.id === 'player') + 1,
      boats: standings.length,
      caloriesKcal: kcal,
    };
  }
}

export function formatTime(ms: number, tenths = false): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return tenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
