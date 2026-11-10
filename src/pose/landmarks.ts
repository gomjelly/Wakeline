// MediaPipe Pose 33개 관절 중 로잉에 쓰는 것들의 인덱스.

export interface Landmark {
  x: number; // 0~1, 영상 너비 기준
  y: number; // 0~1, 영상 높이 기준
  z: number;
  visibility?: number;
}

export type Side = 'left' | 'right';

export const LM = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
} as const;

export type Joint = keyof (typeof LM)['left'];

export const KEY_JOINTS: Joint[] = ['shoulder', 'wrist', 'hip', 'knee', 'ankle'];
