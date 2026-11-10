// MediaPipe Pose Landmarker 래퍼 (FR-CAM-02). 모델과 실행 장치(GPU/CPU)를 바꿔가며 측정할 수 있다.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
import type { Landmark } from './landmarks';

export type ModelKind = 'lite' | 'full' | 'heavy';
export type Delegate = 'GPU' | 'CPU';

export interface DetectResult {
  landmarks: Landmark[] | null;
  inferenceMs: number;
}

let filesetPromise: Promise<WasmFileset> | null = null;

function fileset(): Promise<WasmFileset> {
  filesetPromise ??= FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', document.baseURI).href);
  return filesetPromise;
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private lastTs = 0;
  model: ModelKind = 'full';
  delegate: Delegate = 'GPU';

  get ready(): boolean {
    return this.landmarker !== null;
  }

  /** 실제로 적용된 delegate를 돌려준다(GPU 실패 시 CPU로 내려감). */
  async init(model: ModelKind, delegate: Delegate): Promise<Delegate> {
    this.close();
    const fs = await fileset();
    const modelAssetPath = new URL(`models/pose_landmarker_${model}.task`, document.baseURI).href;
    const create = (d: Delegate) =>
      PoseLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath, delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

    let used = delegate;
    try {
      this.landmarker = await create(delegate);
    } catch (err) {
      if (delegate !== 'GPU') throw err;
      console.warn('GPU 초기화 실패, CPU로 전환합니다.', err);
      used = 'CPU';
      this.landmarker = await create('CPU');
    }
    this.model = model;
    this.delegate = used;
    return used;
  }

  detect(video: HTMLVideoElement): DetectResult {
    if (!this.landmarker) return { landmarks: null, inferenceMs: 0 };
    // VIDEO 모드는 타임스탬프가 단조 증가해야 한다.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, ts);
    const inferenceMs = performance.now() - t0;
    const lms = result.landmarks[0];
    return { landmarks: lms && lms.length ? (lms as Landmark[]) : null, inferenceMs };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;
