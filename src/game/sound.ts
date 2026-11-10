// 레이스 효과음. 소리 파일 없이 Web Audio로 합성한다(오프라인 동작, 저작권 걱정 없음).
//   카운트다운 삑 / 시작 휘슬 / 종료 휘슬 / 노 젓는 소리(여러 가지) / 물소리(여러 가지)
// 물소리는 흰 잡음 대신 핑크·브라운 잡음과 물방울(보글) 소리를 섞어 자연스럽게 만든다.

const PREF = {
  volume: 'wakeline.volume',
  muted: 'wakeline.muted',
  stroke: 'wakeline.sound.stroke',
  flow: 'wakeline.sound.flow',
};

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 무시 */
  }
}

export type StrokeSoundId = 'scull' | 'soft' | 'deep' | 'crisp' | 'classic';
export type FlowSoundId = 'river' | 'hull' | 'lapping' | 'rush' | 'classic' | 'off';

export const STROKE_SOUNDS: { id: StrokeSoundId; label: string }[] = [
  { id: 'scull', label: '실제 스컬 (딸깍 + 물 잡기)' },
  { id: 'soft', label: '부드러운 물결' },
  { id: 'deep', label: '깊고 묵직하게' },
  { id: 'crisp', label: '가볍고 경쾌하게' },
  { id: 'classic', label: '처음 버전 (첨벙 + 쏴아)' },
];

export const FLOW_SOUNDS: { id: FlowSoundId; label: string }[] = [
  { id: 'river', label: '강물 (잔잔 + 보글보글)' },
  { id: 'hull', label: '선체가 물 가르는 소리 (쉬익)' },
  { id: 'lapping', label: '찰랑이는 물결' },
  { id: 'rush', label: '빠른 물살' },
  { id: 'classic', label: '처음 버전' },
  { id: 'off', label: '물소리 끄기' },
];

type NoiseKind = 'white' | 'pink' | 'brown';

interface FlowNodes {
  id: FlowSoundId;
  src: AudioBufferSourceNode;
  gain: GainNode;
  lp: BiquadFilterNode;
  bp: BiquadFilterNode | null;
  extra: AudioScheduledSourceNode[];
  dest: AudioNode;
  /** 다음 물방울 소리를 낼 시각(performance.now 기준) */
  bubbleAt: number;
}

/** 미리듣기 종류: 전체(삑+휘슬+노+물) / 노 소리 / 물소리(+노) */
export type PreviewKind = 'all' | 'stroke' | 'flow';

export class RaceSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise: Record<NoiseKind, AudioBuffer> = {} as Record<NoiseKind, AudioBuffer>;
  private flow: FlowNodes | null = null;
  private speed = 0;
  private _volume = Number(readPref(PREF.volume, '0.7'));
  private _muted = readPref(PREF.muted, '0') === '1';
  private _stroke = readPref(PREF.stroke, 'scull') as StrokeSoundId;
  private _flow = readPref(PREF.flow, 'river') as FlowSoundId;
  /** 테스트용: 소리를 낼 때마다 이름을 알려준다 */
  onEvent?: (name: string) => void;

  get volume(): number {
    return this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }
  get strokeSound(): StrokeSoundId {
    return this._stroke;
  }
  get flowSound(): FlowSoundId {
    return this._flow;
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    writePref(PREF.volume, String(this._volume));
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    writePref(PREF.muted, m ? '1' : '0');
    this.applyMaster();
  }

  setStrokeSound(id: StrokeSoundId): void {
    this._stroke = id;
    writePref(PREF.stroke, id);
  }

  /** 물소리 종류를 바꾼다. 재생 중이면 바로 새 소리로 바꾼다. */
  setFlowSound(id: FlowSoundId): void {
    this._flow = id;
    writePref(PREF.flow, id);
    if (this.flow) {
      this.stopFlow();
      this.startFlow();
      this.setSpeed(this.speed);
    }
  }

  private applyMaster(): void {
    if (!this.ctx) return;
    const target = this._muted ? 0 : this._volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  /** 사용자 동작(버튼 클릭 등) 안에서 한 번 불러야 소리가 난다. */
  async ensure(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.noise.white = this.makeNoise('white');
      this.noise.pink = this.makeNoise('pink');
      this.noise.brown = this.makeNoise('brown');
      this.applyMaster();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** 4초짜리 잡음. 핑크·브라운은 낮은 소리가 많아 흰 잡음보다 물소리에 가깝다. */
  private makeNoise(kind: NoiseKind): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        // Paul Kellet 근사
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    // 반복 이음매에서 딸깍 소리가 나지 않게 앞뒤를 살짝 겹쳐 페이드
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }
    return buf;
  }

  private get now(): number {
    return this.ctx!.currentTime;
  }

  private env(gain: GainNode, t: number, peak: number, attack: number, hold: number, release: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  private noiseSource(kind: NoiseKind = 'white'): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise[kind];
    src.loop = true;
    return src;
  }

  /** 잡음 한 토막: 필터 → 엔벨로프 → 출력 */
  private burst(
    out: AudioNode,
    t: number,
    o: { kind?: NoiseKind; type: BiquadFilterType; f0: number; f1?: number; q?: number; peak: number; attack: number; hold: number; release: number },
  ): void {
    const ctx = this.ctx!;
    const src = this.noiseSource(o.kind);
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.Q.value = o.q ?? 0.8;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.attack + o.hold + o.release);
    const g = ctx.createGain();
    this.env(g, t, o.peak, o.attack, o.hold, o.release);
    src.connect(f).connect(g).connect(out);
    const offset = Math.random() * 3;
    src.start(t, offset);
    src.stop(t + o.attack + o.hold + o.release + 0.05);
  }

  /** 짧은 음 한 토막(주파수가 f0→f1로 미끄러짐) */
  private tone(out: AudioNode, t: number, o: { type?: OscillatorType; f0: number; f1: number; peak: number; dur: number }): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const g = ctx.createGain();
    this.env(g, t, o.peak, 0.004, o.dur * 0.2, o.dur * 0.8);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  /** 물방울 하나(보글): 위로 올라가는 짧은 사인음 */
  private bubble(out: AudioNode, t: number, peak: number): void {
    const f = 350 + Math.random() * 900;
    this.tone(out, t, { f0: f, f1: f * (1.6 + Math.random()), peak, dur: 0.03 + Math.random() * 0.05 });
  }

  // ---------- 카운트다운 ----------
  beep(final = false, dest: AudioNode = this.master): void {
    if (!this.ctx) return;
    this.onEvent?.(final ? 'beep-final' : 'beep');
    const t = this.now;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = final ? 1320 : 880;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    const g = this.ctx.createGain();
    this.env(g, t, 0.22, 0.005, final ? 0.25 : 0.1, 0.08);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  // ---------- 휘슬 ----------
  /** 심판 호루라기: 높은 음 + 빠른 떨림(구슬 소리) + 바람 소리 */
  private whistleBlast(start: number, dur: number, peak = 0.32, dest: AudioNode = this.master): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 3150;
    const trill = ctx.createOscillator();
    trill.frequency.value = 38;
    const trillDepth = ctx.createGain();
    trillDepth.gain.value = 180;
    trill.connect(trillDepth).connect(osc.frequency);
    const am = ctx.createGain();
    am.gain.value = 0.75;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.25;
    trill.connect(amDepth).connect(am.gain);
    const g = ctx.createGain();
    this.env(g, start, peak, 0.02, Math.max(0, dur - 0.12), 0.1);
    osc.connect(am).connect(g).connect(dest);

    const air = this.noiseSource('white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 3;
    const ag = ctx.createGain();
    this.env(ag, start, peak * 0.35, 0.02, Math.max(0, dur - 0.12), 0.1);
    air.connect(bp).connect(ag).connect(dest);

    for (const n of [osc, trill, air]) {
      n.start(start);
      n.stop(start + dur + 0.2);
    }
  }

  startWhistle(dest: AudioNode = this.master): void {
    if (!this.ctx) return;
    this.onEvent?.('start-whistle');
    this.whistleBlast(this.now, 0.75, 0.32, dest);
  }

  finishWhistle(): void {
    if (!this.ctx) return;
    this.onEvent?.('finish-whistle');
    const t = this.now;
    this.whistleBlast(t, 0.28);
    this.whistleBlast(t + 0.42, 1.1);
  }

  // ---------- 노 젓기 ----------
  /**
   * 노가 물을 잡는 순간(캐치)부터 당기는 동안의 소리.
   * @param strength 0~1 (스트로크 세기)
   * @param pan -1(왼쪽)~1(오른쪽)
   * @param level 0~1 (거리에 따른 크기, 내 배는 1)
   */
  stroke(strength = 0.8, pan = 0, level = 1, preset: StrokeSoundId = this._stroke, dest: AudioNode = this.master): void {
    if (!this.ctx || level < 0.03) return;
    this.onEvent?.(level >= 1 ? 'stroke' : 'rival-stroke');
    const ctx = this.ctx;
    const t = this.now;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    const lv = ctx.createGain();
    lv.gain.value = level;
    out.connect(lv).connect(dest);
    const s = 0.5 + 0.5 * Math.max(0, Math.min(1, strength));

    switch (preset) {
      case 'scull':
        // 노걸이 딸깍(나무·금속) → 날이 물을 잡는 낮은 첨벙 → 물을 미는 브라운 잡음 → 빠질 때 작은 물방울
        this.tone(out, t, { type: 'triangle', f0: 1900, f1: 1200, peak: 0.07 * s, dur: 0.035 });
        this.burst(out, t + 0.01, { kind: 'pink', type: 'bandpass', f0: 1400, f1: 500, q: 1.1, peak: 0.3 * s, attack: 0.008, hold: 0.02, release: 0.16 });
        this.tone(out, t + 0.01, { f0: 160, f1: 70, peak: 0.16 * s, dur: 0.12 });
        this.burst(out, t + 0.05, { kind: 'brown', type: 'lowpass', f0: 380, f1: 850, peak: 0.34 * s, attack: 0.12, hold: 0.18, release: 0.35 });
        for (let i = 0; i < 4; i++) this.bubble(out, t + 0.62 + i * 0.035 + Math.random() * 0.03, 0.03 * s);
        break;
      case 'soft':
        // 부드럽게 스며드는 물결: 공격을 느리게, 고음을 줄여서
        this.burst(out, t, { kind: 'pink', type: 'lowpass', f0: 900, f1: 400, peak: 0.22 * s, attack: 0.05, hold: 0.06, release: 0.3 });
        this.burst(out, t + 0.08, { kind: 'brown', type: 'lowpass', f0: 300, f1: 600, peak: 0.26 * s, attack: 0.18, hold: 0.15, release: 0.45 });
        for (let i = 0; i < 2; i++) this.bubble(out, t + 0.5 + i * 0.06, 0.02 * s);
        break;
      case 'deep':
        // 묵직하게 물을 꽉 잡는 소리: 낮은 '퉁'과 꿀렁이는 물
        this.tone(out, t, { f0: 120, f1: 55, peak: 0.3 * s, dur: 0.2 });
        this.burst(out, t, { kind: 'brown', type: 'lowpass', f0: 600, f1: 200, peak: 0.36 * s, attack: 0.01, hold: 0.05, release: 0.3 });
        this.burst(out, t + 0.1, { kind: 'brown', type: 'bandpass', f0: 250, f1: 450, q: 0.7, peak: 0.28 * s, attack: 0.1, hold: 0.25, release: 0.35 });
        for (let i = 0; i < 6; i++) this.bubble(out, t + 0.15 + i * 0.07 + Math.random() * 0.04, 0.028 * s);
        break;
      case 'crisp':
        // 가볍고 경쾌한 물 튀김
        this.burst(out, t, { kind: 'white', type: 'bandpass', f0: 3200, f1: 1200, q: 1.4, peak: 0.26 * s, attack: 0.004, hold: 0.01, release: 0.12 });
        this.burst(out, t + 0.03, { kind: 'pink', type: 'highpass', f0: 1200, peak: 0.12 * s, attack: 0.04, hold: 0.08, release: 0.2 });
        for (let i = 0; i < 3; i++) this.bubble(out, t + 0.02 + i * 0.025, 0.03 * s);
        break;
      case 'classic':
      default:
        this.burst(out, t, { kind: 'white', type: 'bandpass', f0: 2600, f1: 700, q: 1.2, peak: 0.42 * s, attack: 0.006, hold: 0.03, release: 0.22 });
        this.tone(out, t, { f0: 220, f1: 70, peak: 0.25 * s, dur: 0.14 });
        this.burst(out, t + 0.05, { kind: 'white', type: 'lowpass', f0: 500, f1: 1100, peak: 0.16 * s, attack: 0.1, hold: 0.1, release: 0.5 });
        break;
    }
  }

  // ---------- 물소리 ----------
  /** 물소리 노드를 만든다(dest로 출력). 물소리 끄기면 null */
  private createFlow(dest: AudioNode, id: FlowSoundId = this._flow): FlowNodes | null {
    if (!this.ctx || id === 'off') return null;
    const ctx = this.ctx;
    const kind: NoiseKind = id === 'classic' ? 'white' : id === 'hull' ? 'pink' : 'brown';
    const src = this.noiseSource(kind);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    let bp: BiquadFilterNode | null = null;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    // 물결처럼 크기가 천천히 출렁이게
    const wobble = ctx.createGain();
    wobble.gain.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = id === 'lapping' ? 0.45 : 0.25;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = id === 'lapping' ? 0.5 : 0.18;
    lfo.connect(lfoDepth).connect(wobble.gain);

    let node: AudioNode = src;
    if (id === 'hull') {
      // 선체가 물을 가르는 쉬익: 중고음 대역만
      bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.6;
      node = node.connect(bp);
    }
    node.connect(lp).connect(wobble).connect(gain).connect(dest);
    src.start(0, Math.random() * 3);
    lfo.start();
    return { id, src, gain, lp, bp, extra: [lfo], dest, bubbleAt: 0 };
  }

  /** 속도(m/s)에 맞춰 물소리 크기·음색을 바꾸고, 가끔 물방울을 섞는다. */
  private applyFlow(f: FlowNodes, mps: number): void {
    const k = Math.min(1, Math.max(0, mps) / 5);
    const t = this.now;
    let gain: number, cutoff: number;
    switch (f.id) {
      case 'river':
        gain = 0.06 + 0.35 * k;
        cutoff = 350 + 900 * k;
        break;
      case 'hull':
        gain = 0.015 + 0.3 * k * k;
        cutoff = 1500 + 3500 * k;
        if (f.bp) f.bp.frequency.setTargetAtTime(1200 + 1800 * k, t, 0.2);
        break;
      case 'lapping':
        gain = 0.1 + 0.2 * k;
        cutoff = 300 + 500 * k;
        break;
      case 'rush':
        gain = 0.04 + 0.55 * k;
        cutoff = 500 + 2200 * k;
        break;
      case 'classic':
      default:
        gain = 0.03 + 0.3 * k * k + 0.05 * k;
        cutoff = 320 + 1500 * k;
    }
    f.gain.gain.setTargetAtTime(gain, t, 0.15);
    f.lp.frequency.setTargetAtTime(cutoff, t, 0.15);

    if (f.id === 'river' || f.id === 'lapping' || f.id === 'rush') {
      const perSec = (f.id === 'lapping' ? 2 : 1) + 7 * k;
      const nowMs = performance.now();
      if (nowMs > f.bubbleAt) {
        f.bubbleAt = nowMs + (1000 / perSec) * (0.4 + Math.random() * 1.2);
        const out = this.ctx!.createStereoPanner();
        out.pan.value = Math.random() * 1.6 - 0.8;
        out.connect(f.dest);
        this.bubble(out, t, 0.012 + 0.02 * k);
      }
    }
  }

  private killFlow(f: FlowNodes, fade = 0.2): void {
    const t = this.now;
    f.gain.gain.cancelScheduledValues(t);
    f.gain.gain.setTargetAtTime(0, t, fade);
    f.src.stop(t + fade * 5);
    for (const x of f.extra) x.stop(t + fade * 5);
  }

  startFlow(): void {
    if (!this.ctx || this.flow) return;
    this.flow = this.createFlow(this.master);
  }

  /** 테스트용: 지금 물소리 크기 */
  get flowLevel(): number {
    return this.flow?.gain.gain.value ?? 0;
  }

  /** 배 속도(m/s)에 맞춰 물소리를 바꾼다. 매 프레임 불러도 된다. */
  setSpeed(mps: number): void {
    this.speed = Math.max(0, mps);
    if (this.ctx && this.flow) this.applyFlow(this.flow, this.speed);
  }

  stopFlow(): void {
    if (!this.ctx || !this.flow) return;
    this.killFlow(this.flow);
    this.flow = null;
  }

  // ---------- 미리듣기 ----------
  // 한 번에 하나만 재생한다. 미리듣기 소리는 전용 통로(bus)로만 내보내서,
  // 멈출 때 통로를 끊으면 이미 예약된 소리까지 바로 사라진다.
  private preview: {
    kind: PreviewKind;
    bus: GainNode;
    timers: number[];
    flow: FlowNodes | null;
  } | null = null;
  /** 미리듣기 상태가 바뀔 때(시작: 종류, 끝·멈춤: null) */
  onPreviewChange?: (kind: PreviewKind | null) => void;

  get previewing(): PreviewKind | null {
    return this.preview?.kind ?? null;
  }

  /** 미리듣기를 처음부터 재생한다. 다른 미리듣기가 재생 중이면 먼저 멈춘다. */
  async startPreview(kind: PreviewKind): Promise<void> {
    await this.ensure();
    this.stopPreview(false);
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    bus.connect(this.master);
    const p = { kind, bus, timers: [] as number[], flow: null as FlowNodes | null };
    this.preview = p;
    const at = (ms: number, fn: () => void) =>
      p.timers.push(window.setTimeout(() => {
        if (this.preview === p) fn();
      }, ms));

    let offset = 0;
    if (kind === 'all') {
      this.beep(false, bus);
      at(600, () => this.startWhistle(bus));
      offset = 1500;
    }
    let endMs: number;
    if (kind === 'stroke') {
      [0, 1500, 3000].forEach((ms) => at(ms, () => this.stroke(0.9, 0, 1, this._stroke, bus)));
      endMs = 3000 + 1100;
    } else {
      // 물소리가 빨라졌다 느려지는 동안 노를 4번 젓는다(약 6초)
      const steps = [0.5, 2.2, 3.6, 4.4, 4.6, 4.2, 3.4, 2.4, 1.4, 0.6, 0];
      const total = (steps.length - 1) * 600;
      at(offset, () => {
        p.flow = this.createFlow(bus);
        const t0 = performance.now();
        const iv = window.setInterval(() => {
          if (this.preview !== p) {
            window.clearInterval(iv);
            return;
          }
          const x = Math.min(steps.length - 1, (performance.now() - t0) / 600);
          const i = Math.floor(x);
          const v = steps[i] + (steps[Math.min(steps.length - 1, i + 1)] - steps[i]) * (x - i);
          if (p.flow) this.applyFlow(p.flow, v);
        }, 50);
        p.timers.push(iv);
      });
      [400, 1900, 3400, 4900].forEach((ms) => at(offset + ms, () => this.stroke(0.9, 0, 1, this._stroke, bus)));
      endMs = offset + total + 600;
    }
    at(endMs, () => this.stopPreview());
    this.onPreviewChange?.(kind);
  }

  /** 미리듣기를 멈춘다(재생 중인 소리도 바로 끊는다). */
  stopPreview(notify = true): void {
    const p = this.preview;
    if (!p) return;
    this.preview = null;
    for (const id of p.timers) {
      window.clearTimeout(id);
      window.clearInterval(id);
    }
    if (p.flow) this.killFlow(p.flow, 0.03);
    const t = this.now;
    p.bus.gain.cancelScheduledValues(t);
    p.bus.gain.setTargetAtTime(0, t, 0.02);
    window.setTimeout(() => p.bus.disconnect(), 200);
    if (notify) this.onPreviewChange?.(null);
  }
}
