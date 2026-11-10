// 카메라 목록 조회와 스트림 시작 (FR-CAM-01). 선택값은 localStorage에 유지한다.

const STORAGE_KEY = 'wakeline.cameraId';

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface CameraStartResult {
  width: number;
  height: number;
  frameRate: number;
  label: string;
}

export function savedCameraId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveCameraId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 저장 실패는 무시 */
  }
}

export async function listCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `카메라 ${i + 1}` }));
}

export class Camera {
  private stream: MediaStream | null = null;

  constructor(readonly video: HTMLVideoElement) {}

  async start(deviceId: string | null, width: number, height: number): Promise<CameraStartResult> {
    this.stop();
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.stream.getVideoTracks()[0];
    const s = track.getSettings();
    if (s.deviceId) saveCameraId(s.deviceId);

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    return {
      width: s.width ?? this.video.videoWidth,
      height: s.height ?? this.video.videoHeight,
      frameRate: s.frameRate ?? 0,
      label: track.label,
    };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
