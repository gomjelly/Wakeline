// public/config/game.config.json 을 읽는다. 값을 바꾸고 새로고침하면 반영된다.

export interface DetectionConfig {
  minVisibility: number;
  smoothingAlpha: number;
  catchThreshold: number;
  finishThreshold: number;
  hysteresis: number;
  minStrokeIntervalMs: number;
  lostPersonPauseMs: number;
  side: 'auto' | 'left' | 'right';
}

export interface RaceConfig {
  countdownSec: number;
  resumeCountdownSec: number;
  distancesM: number[];
  defaultDistanceM: number;
}

export type DifficultyId = 'easy' | 'normal' | 'hard';

export interface DifficultyConfig {
  splitSec: number;
  spm: [number, number];
  paceVariance: number;
  finalSprint: number;
}

export interface PhysicsConfig {
  propulsionGain: number;
  dragCoefficient: number;
  maxSpeedMps: number;
}

export interface AiConfig {
  /** AI 보트 수 */
  count: number;
  /** AI끼리 목표 스플릿을 이만큼(초) 벌려 놓는다 */
  spreadSec: number;
}

export interface GameConfig {
  race: RaceConfig;
  difficulty: Record<DifficultyId, DifficultyConfig>;
  physics: PhysicsConfig;
  ai: AiConfig;
  detection: DetectionConfig;
  user: { weightKg: number };
}

const DEFAULTS: GameConfig = {
  race: { countdownSec: 5, resumeCountdownSec: 3, distancesM: [500, 1000, 2000, 5000], defaultDistanceM: 1000 },
  difficulty: {
    // 기준: 200회 ≈ 1km, 약 9분 → 보통 = 4:30/500m, 22SPM 안팎
    easy: { splitSec: 300, spm: [18, 22], paceVariance: 0.06, finalSprint: 0.0 },
    normal: { splitSec: 270, spm: [20, 24], paceVariance: 0.04, finalSprint: 0.03 },
    hard: { splitSec: 240, spm: [22, 26], paceVariance: 0.03, finalSprint: 0.06 },
  },
  // 스트로크 1회 거리 ≈ propulsionGain / dragCoefficient × 스트로크 길이(0.75~1) ≈ 4.3~5.8m, 평균 약 5m
  // 실제로 200회에 X km가 나오면 propulsionGain에 (1 / X)를 곱해 맞춘다.
  physics: { propulsionGain: 4.6, dragCoefficient: 0.8, maxSpeedMps: 7.0 },
  ai: { count: 3, spreadSec: 12 },
  detection: {
    minVisibility: 0.5,
    smoothingAlpha: 0.35,
    catchThreshold: 0.25,
    finishThreshold: 0.75,
    hysteresis: 0.05,
    minStrokeIntervalMs: 800,
    lostPersonPauseMs: 3000,
    side: 'auto',
  },
  user: { weightKg: 70 },
};

export async function loadConfig(): Promise<GameConfig> {
  try {
    const res = await fetch(new URL('config/game.config.json', document.baseURI), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Partial<GameConfig>;
    return {
      race: { ...DEFAULTS.race, ...json.race },
      difficulty: {
        easy: { ...DEFAULTS.difficulty.easy, ...json.difficulty?.easy },
        normal: { ...DEFAULTS.difficulty.normal, ...json.difficulty?.normal },
        hard: { ...DEFAULTS.difficulty.hard, ...json.difficulty?.hard },
      },
      physics: { ...DEFAULTS.physics, ...json.physics },
      ai: { ...DEFAULTS.ai, ...json.ai },
      detection: { ...DEFAULTS.detection, ...json.detection },
      user: { ...DEFAULTS.user, ...json.user },
    };
  } catch (err) {
    console.warn('설정 파일을 읽지 못해 기본값을 씁니다.', err);
    return structuredClone(DEFAULTS);
  }
}

// ---------- 맵 정의 (FR-GAM-01) ----------

export interface MapBridge {
  name: string;
  /** 출발선에서의 거리(m) */
  distanceM: number;
}

export interface MapDefinition {
  id: string;
  name: string;
  description: string;
  riverWidthM: number;
  bridges: MapBridge[];
  /** 하늘 연출: 해 고도(도). 낮을수록 노을 */
  sunElevationDeg: number;
}

export async function loadMap(id: string): Promise<MapDefinition> {
  const res = await fetch(new URL(`maps/${id}/map.json`, document.baseURI), { cache: 'no-store' });
  if (!res.ok) throw new Error(`맵을 불러오지 못했습니다: ${id}`);
  return (await res.json()) as MapDefinition;
}
