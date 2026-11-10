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

export interface GameConfig {
  detection: DetectionConfig;
  // 나머지 섹션(race, difficulty, physics, ui, user)은 이후 단계에서 타입을 붙인다.
  [section: string]: unknown;
}

const DEFAULT_DETECTION: DetectionConfig = {
  minVisibility: 0.5,
  smoothingAlpha: 0.35,
  catchThreshold: 0.25,
  finishThreshold: 0.75,
  hysteresis: 0.05,
  minStrokeIntervalMs: 800,
  lostPersonPauseMs: 3000,
  side: 'auto',
};

export async function loadConfig(): Promise<GameConfig> {
  try {
    const res = await fetch(new URL('config/game.config.json', document.baseURI), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Partial<GameConfig>;
    return { ...json, detection: { ...DEFAULT_DETECTION, ...(json.detection ?? {}) } };
  } catch (err) {
    console.warn('설정 파일을 읽지 못해 기본값을 씁니다.', err);
    return { detection: { ...DEFAULT_DETECTION } };
  }
}
