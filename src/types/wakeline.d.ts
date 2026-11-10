export interface DisplayInfo {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
  current: boolean;
}

export interface WindowState {
  fullscreen: boolean;
  displayId: number;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string; // data URL
}

export interface TestConfig {
  captureTitle: string | null;
  logMetrics: boolean;
  startCheck: boolean;
}

export interface WakelineBridge {
  listCaptureSources(): Promise<CaptureSource[]>;
  selectCaptureSource(id: string): Promise<boolean>;
  getTestConfig(): Promise<TestConfig>;
  sendMetrics(line: string): void;
  listDisplays(): Promise<DisplayInfo[]>;
  getWindowState(): Promise<WindowState | null>;
  moveToDisplay(displayId: number, fullscreen: boolean): Promise<boolean>;
  setFullscreen(on: boolean): Promise<WindowState | null>;
  onDisplaysChanged(cb: (displays: DisplayInfo[]) => void): () => void;
  onWindowState(cb: (state: WindowState) => void): () => void;
}

declare global {
  interface Window {
    /** Electron에서 실행할 때만 존재한다. 브라우저 모드에서는 undefined. */
    wakeline?: WakelineBridge;
  }
}
