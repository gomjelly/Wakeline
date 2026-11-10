// 게임 시작 전 카메라·자세 점검 로직. DOM에 의존하지 않아 녹화 좌표로 테스트할 수 있다.
//
// 항목: 영상 수신 → 밝기 → 사람 인식 → 전신 보임 → 거리(크기) → 측면 각도 → 동작(스트로크 3회)
// 필수(required) 항목이 모두 통과하고 실패 항목이 없으면 준비 완료.

import type { DetectionConfig } from '../config';
import type { PoseMetrics } from '../pose/handleIndex';
import { KEY_JOINTS, LM, type Joint, type Landmark } from '../pose/landmarks';

export type CheckState = 'pending' | 'pass' | 'warn' | 'fail';

export type CheckId = 'camera' | 'light' | 'person' | 'fullBody' | 'size' | 'side' | 'motion';

export interface CheckItem {
  id: CheckId;
  label: string;
  state: CheckState;
  /** 짧은 현재 값/상태 */
  detail: string;
  /** 통과하지 못했을 때 사용자에게 보여줄 안내 */
  hint: string;
  required: boolean;
}

export interface CheckResult {
  items: CheckItem[];
  ready: boolean;
  /** 지금 가장 먼저 해결해야 할 안내 문구 */
  guidance: string;
  strokeCount: number;
  strokesNeeded: number;
}

export interface CheckFrame {
  t: number;
  landmarks: Landmark[] | null;
  metrics: PoseMetrics;
  aspect: number;
}

const JOINT_NAME: Record<Joint, string> = {
  shoulder: '어깨',
  elbow: '팔꿈치',
  wrist: '손목',
  hip: '엉덩이',
  knee: '무릎',
  ankle: '발목',
};

const WINDOW_MS = 2000;
const STROKES_NEEDED = 3;
const EDGE = 0.02;

interface Sample {
  t: number;
  hasPerson: boolean;
  missing: Joint[];
  outOfFrame: boolean;
  span: number | null; // 관절 묶음 크기(영상 대비 0~1)
  sideRatio: number | null; // 어깨·엉덩이 좌우 간격 / 몸통 길이. 작을수록 측면
}

export class CameraCheck {
  private samples: Sample[] = [];
  private strokeCount = 0;
  private armed = false; // 캐치 구간을 지나 피니시를 기다리는 중
  private lastStrokeT = -Infinity;
  private lastSeenT = -Infinity;

  constructor(private cfg: DetectionConfig) {}

  reset(): void {
    this.samples = [];
    this.strokeCount = 0;
    this.armed = false;
    this.lastStrokeT = -Infinity;
    this.lastSeenT = -Infinity;
  }

  /** 자세 인식 결과가 나올 때마다 호출한다. */
  push(f: CheckFrame): void {
    const lms = f.landmarks;
    const s: Sample = { t: f.t, hasPerson: !!lms, missing: [], outOfFrame: false, span: null, sideRatio: null };

    if (lms) {
      this.lastSeenT = f.t;
      const p = LM[f.metrics.side];
      const minVis = this.cfg.minVisibility;
      s.missing = KEY_JOINTS.filter((j) => (lms[p[j]]?.visibility ?? 0) < minVis);

      const pts = KEY_JOINTS.map((j) => lms[p[j]]).filter((l) => (l.visibility ?? 0) >= minVis);
      if (pts.length) {
        const xs = pts.map((l) => l.x), ys = pts.map((l) => l.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        s.outOfFrame = minX < EDGE || maxX > 1 - EDGE || minY < EDGE || maxY > 1 - EDGE;
        // 관절 묶음이 가로·세로 중 화면을 더 많이 차지하는 쪽의 비율
        s.span = Math.max(maxX - minX, maxY - minY);
      }

      const ls = lms[LM.left.shoulder], rs = lms[LM.right.shoulder];
      const lh = lms[LM.left.hip], rh = lms[LM.right.hip];
      const torso = Math.hypot(((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2) * f.aspect, (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2);
      if (torso > 1e-3) {
        const sep = (Math.abs(ls.x - rs.x) + Math.abs(lh.x - rh.x)) / 2;
        s.sideRatio = (sep * f.aspect) / torso;
      }
    } else if (f.t - this.lastSeenT > this.cfg.lostPersonPauseMs) {
      // 사람이 한동안 사라지면 동작 확인을 처음부터 다시 한다.
      this.strokeCount = 0;
      this.armed = false;
    }

    this.countStroke(f.t, f.metrics.index);

    this.samples.push(s);
    while (this.samples.length && this.samples[0].t < f.t - WINDOW_MS) this.samples.shift();
  }

  private countStroke(t: number, index: number | null): void {
    if (index === null) return;
    const h = this.cfg.hysteresis;
    if (index <= this.cfg.catchThreshold - h) this.armed = true;
    else if (this.armed && index >= this.cfg.finishThreshold + h && t - this.lastStrokeT >= this.cfg.minStrokeIntervalMs) {
      this.armed = false;
      this.lastStrokeT = t;
      this.strokeCount = Math.min(this.strokeCount + 1, 99);
    }
  }

  /**
   * @param camFps 영상 수신 fps
   * @param brightness 평균 밝기 0~255 (모르면 null)
   */
  evaluate(camFps: number, brightness: number | null): CheckResult {
    const ss = this.samples;
    const n = ss.length;
    const ratio = (pred: (s: Sample) => boolean) => (n ? ss.filter(pred).length / n : 0);
    const items: CheckItem[] = [];

    // 1. 영상 수신
    items.push({
      id: 'camera',
      label: '카메라 영상',
      required: true,
      ...(camFps >= 20
        ? { state: 'pass', detail: `${camFps.toFixed(0)}fps`, hint: '' }
        : camFps >= 10
          ? { state: 'warn', detail: `${camFps.toFixed(0)}fps`, hint: '영상이 끊깁니다. 방을 밝게 하거나 해상도를 낮춰 보세요.' }
          : { state: 'fail', detail: camFps > 0 ? `${camFps.toFixed(0)}fps` : '영상 없음', hint: '카메라 영상이 들어오지 않습니다. 카메라 연결과 선택을 확인하세요.' }),
    });

    // 2. 밝기
    items.push({
      id: 'light',
      label: '밝기',
      required: false,
      ...(brightness === null
        ? { state: 'pending', detail: '측정 중', hint: '' }
        : brightness < 45
          ? { state: 'fail', detail: '너무 어두움', hint: '너무 어둡습니다. 조명을 켜 주세요.' }
          : brightness < 70
            ? { state: 'warn', detail: '조금 어두움', hint: '조금 어둡습니다. 밝을수록 인식이 정확해요.' }
            : brightness > 215
              ? { state: 'warn', detail: '너무 밝음', hint: '화면이 너무 밝습니다. 창문을 등지고 있다면 역광을 피해 주세요.' }
              : { state: 'pass', detail: '적당함', hint: '' }),
    });

    // 3. 사람 인식
    const personRatio = ratio((s) => s.hasPerson);
    items.push({
      id: 'person',
      label: '사람 인식',
      required: true,
      ...(n < 10
        ? { state: 'pending', detail: '확인 중', hint: '로잉머신에 앉아 카메라 화면 안으로 들어와 주세요.' }
        : personRatio >= 0.9
          ? { state: 'pass', detail: '인식됨', hint: '' }
          : personRatio >= 0.5
            ? { state: 'warn', detail: '가끔 놓침', hint: '인식이 자주 끊깁니다. 몸 전체가 화면에 들어오게 해 주세요.' }
            : { state: 'fail', detail: '인식 안 됨', hint: '사람이 보이지 않습니다. 로잉머신에 앉아 카메라 화면 안으로 들어와 주세요.' }),
    });

    const withPerson = ss.filter((s) => s.hasPerson);
    const pn = withPerson.length;
    const personOk = personRatio >= 0.5 && pn >= 10;

    // 4. 전신 보임
    const missCount = new Map<Joint, number>();
    for (const s of withPerson) for (const j of s.missing) missCount.set(j, (missCount.get(j) ?? 0) + 1);
    const missing = [...missCount.entries()].filter(([, c]) => c / Math.max(1, pn) > 0.2).map(([j]) => j);
    const cut = pn ? withPerson.filter((s) => s.outOfFrame).length / pn > 0.2 : false;
    items.push({
      id: 'fullBody',
      label: '전신 보임',
      required: true,
      ...(!personOk
        ? { state: 'pending', detail: '-', hint: '' }
        : missing.length
          ? {
              state: 'fail',
              detail: `${missing.map((j) => JOINT_NAME[j]).join('·')} 안 보임`,
              hint: `${missing.map((j) => JOINT_NAME[j]).join(', ')}이(가) 잘 안 보입니다. 카메라를 옮겨 몸 전체가 보이게 해 주세요.`,
            }
          : cut
            ? { state: 'warn', detail: '화면 끝에 걸림', hint: '몸이 화면 끝에 걸립니다. 카메라를 조금 멀리 두세요.' }
            : { state: 'pass', detail: '모두 보임', hint: '' }),
    });

    // 5. 거리(크기)
    const spans = withPerson.map((s) => s.span).filter((v): v is number => v !== null);
    const span = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
    items.push({
      id: 'size',
      label: '거리',
      required: false,
      ...(!personOk || span === null
        ? { state: 'pending', detail: '-', hint: '' }
        : span < 0.3
          ? { state: 'warn', detail: '너무 멂', hint: '몸이 너무 작게 보입니다. 카메라를 조금 가까이 두세요.' }
          : { state: 'pass', detail: `화면의 ${Math.round(span * 100)}%`, hint: '' }),
    });

    // 6. 측면 각도
    const sides = withPerson.map((s) => s.sideRatio).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const sideRatio = sides.length ? sides[Math.floor(sides.length / 2)] : null;
    items.push({
      id: 'side',
      label: '측면 각도',
      required: false,
      ...(!personOk || sideRatio === null
        ? { state: 'pending', detail: '-', hint: '' }
        : sideRatio < 0.35
          ? { state: 'pass', detail: '측면', hint: '' }
          : sideRatio < 0.7
            ? { state: 'warn', detail: '대각선', hint: '대각선으로 보입니다. 카메라를 로잉머신 바로 옆에 두면 더 정확해요.' }
            : { state: 'fail', detail: '정면/후면', hint: '정면이나 뒤에서 찍히고 있습니다. 카메라를 로잉머신 옆(측면)으로 옮겨 주세요.' }),
    });

    // 7. 동작 확인
    const done = this.strokeCount >= STROKES_NEEDED;
    items.push({
      id: 'motion',
      label: '노 젓기 확인',
      required: true,
      state: done ? 'pass' : 'pending',
      detail: `${Math.min(this.strokeCount, STROKES_NEEDED)} / ${STROKES_NEEDED}회`,
      hint: done ? '' : `천천히 크게 ${STROKES_NEEDED}번 저어 보세요. (${Math.min(this.strokeCount, STROKES_NEEDED)}/${STROKES_NEEDED})`,
    });

    const ready = items.every((i) => i.state !== 'fail' && (!i.required || i.state === 'pass'));
    const first =
      items.find((i) => i.state === 'fail') ??
      items.find((i) => i.required && i.state !== 'pass' && i.hint) ??
      items.find((i) => i.state === 'warn');
    const guidance = ready
      ? first?.state === 'warn'
        ? `준비 완료! (참고: ${first.hint})`
        : '준비 완료! 게임을 시작할 수 있어요.'
      : (first?.hint ?? '점검 중입니다…');

    return { items, ready, guidance, strokeCount: this.strokeCount, strokesNeeded: STROKES_NEEDED };
  }
}
