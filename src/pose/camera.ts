// 영상 입력: 카메라(FR-CAM-01) 또는 동영상 파일(카메라 없이 시뮬레이션·튜닝용).
// 카메라 선택값은 localStorage에 유지한다.

const STORAGE_KEY = 'wakeline.cameraId';

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface SourceInfo {
  width: number;
  height: number;
  frameRate: number;
  label: string;
}

export type SourceKind = 'camera' | 'file' | 'capture' | 'none';

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
  private fileUrl: string | null = null;
  kind: SourceKind = 'none';

  constructor(readonly video: HTMLVideoElement) {}

  async start(deviceId: string | null, width: number, height: number): Promise<SourceInfo> {
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

    this.video.loop = false;
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.kind = 'camera';

    return {
      width: s.width ?? this.video.videoWidth,
      height: s.height ?? this.video.videoHeight,
      frameRate: s.frameRate ?? 0,
      label: track.label,
    };
  }

  /** 동영상 파일을 반복 재생한다. 파일은 메모리(blob URL)에서만 읽고 어디에도 보내지 않는다. */
  async startFile(file: File): Promise<SourceInfo> {
    this.stop();
    this.fileUrl = URL.createObjectURL(file);
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.src = this.fileUrl;
    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('이 동영상 형식은 재생할 수 없습니다 (mp4/H.264 또는 webm 권장)'));
      };
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', fail);
      };
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', fail);
    });
    await v.play();
    this.kind = 'file';
    return { width: v.videoWidth, height: v.videoHeight, frameRate: 0, label: file.name };
  }

  /**
   * 화면/창 캡처. Electron에서는 미리 고른 창이, 브라우저에서는 브라우저의 선택 창이 쓰인다.
   * 캡처한 화면은 메모리에서만 처리하고 저장하지 않는다.
   */
  async startDisplay(onEnded: () => void): Promise<SourceInfo> {
    this.stop();
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    const track = this.stream.getVideoTracks()[0];
    track.addEventListener('ended', onEnded);
    this.video.loop = false;
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.kind = 'capture';
    const s = track.getSettings();
    return {
      width: this.video.videoWidth || s.width || 0,
      height: this.video.videoHeight || s.height || 0,
      frameRate: s.frameRate ?? 0,
      label: track.label,
    };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    if (this.fileUrl) {
      this.video.removeAttribute('src');
      this.video.load();
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
    this.kind = 'none';
  }
}
