// 레이스 효과음. 소리 파일 없이 Web Audio로 합성한다(오프라인 동작, 저작권 걱정 없음).
//   카운트다운 삑 / 시작 휘슬 / 종료 휘슬 / 노가 물에 들어가는 첨벙 + 당기는 쏴아 / 속도에 따른 물살 소리

const PREF_KEY = 'wakeline.volume';
const MUTE_KEY = 'wakeline.muted';

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

export class RaceSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private flowGain: GainNode | null = null;
  private flowLow: BiquadFilterNode | null = null;
  private flowHigh: BiquadFilterNode | null = null;
  private flowSrc: AudioBufferSourceNode | null = null;
  private _volume = Number(readPref(PREF_KEY, '0.7'));
  private _muted = readPref(MUTE_KEY, '0') === '1';
  /** 테스트용: 소리를 낼 때마다 이름을 알려준다 */
  onEvent?: (name: string) => void;

  get volume(): number {
    return this._volume;
  }

  get muted(): boolean {
    return this._muted;
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    writePref(PREF_KEY, String(this._volume));
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    writePref(MUTE_KEY, m ? '1' : '0');
    this.applyMaster();
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
      // 2초짜리 흰 잡음(물소리 재료)
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyMaster();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private get now(): number {
    return this.ctx!.currentTime;
  }

  private env(gain: GainNode, t: number, peak: number, attack: number, hold: number, release: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.setValueAtTime(peak, t + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  private noiseSource(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    return src;
  }

  // ---------- 카운트다운 ----------
  /** 카운트다운 삑. final이면 조금 높고 길게. */
  beep(final = false): void {
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
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  // ---------- 휘슬 ----------
  /** 심판 호루라기: 높은 음 + 빠른 떨림(구슬 소리) + 바람 소리 */
  private whistleBlast(start: number, dur: number, peak = 0.32): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 3150;
    // 구슬이 굴러 생기는 떨림
    const trill = ctx.createOscillator();
    trill.frequency.value = 38;
    const trillDepth = ctx.createGain();
    trillDepth.gain.value = 180;
    trill.connect(trillDepth).connect(osc.frequency);
    // 진폭도 같이 떨린다
    const am = ctx.createGain();
    am.gain.value = 0.75;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.25;
    trill.connect(amDepth).connect(am.gain);

    const g = ctx.createGain();
    this.env(g, start, peak, 0.02, Math.max(0, dur - 0.12), 0.1);
    osc.connect(am).connect(g).connect(this.master);

    // 바람(숨) 소리
    const air = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 3;
    const ag = ctx.createGain();
    this.env(ag, start, peak * 0.35, 0.02, Math.max(0, dur - 0.12), 0.1);
    air.connect(bp).connect(ag).connect(this.master);

    for (const n of [osc, trill, air]) {
      n.start(start);
      n.stop(start + dur + 0.2);
    }
  }

  startWhistle(): void {
    if (!this.ctx) return;
    this.onEvent?.('start-whistle');
    this.whistleBlast(this.now, 0.75);
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
   * 노가 물에 들어가는 순간(캐치)의 첨벙 + 당기는 쏴아.
   * @param strength 0~1 (스트로크 세기)
   * @param pan -1(왼쪽)~1(오른쪽)
   * @param level 0~1 (거리에 따른 크기, 내 배는 1)
   */
  stroke(strength = 0.8, pan = 0, level = 1): void {
    if (!this.ctx || level < 0.03) return;
    this.onEvent?.(level >= 1 ? 'stroke' : 'rival-stroke');
    const ctx = this.ctx;
    const t = this.now;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    const lv = ctx.createGain();
    lv.gain.value = level;
    out.connect(lv).connect(this.master);
    const s = 0.5 + 0.5 * Math.max(0, Math.min(1, strength));

    // 1) 첨벙: 대역 잡음이 위에서 아래로 빠르게 떨어짐
    const splash = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    const sg = ctx.createGain();
    this.env(sg, t, 0.42 * s, 0.006, 0.03, 0.22);
    splash.connect(bp).connect(sg).connect(out);
    splash.start(t);
    splash.stop(t + 0.4);

    // 2) 퐁: 날이 물을 잡는 낮은 소리
    const plop = ctx.createOscillator();
    plop.type = 'sine';
    plop.frequency.setValueAtTime(220, t);
    plop.frequency.exponentialRampToValueAtTime(70, t + 0.14);
    const pg = ctx.createGain();
    this.env(pg, t, 0.25 * s, 0.004, 0.02, 0.12);
    plop.connect(pg).connect(out);
    plop.start(t);
    plop.stop(t + 0.25);

    // 3) 쏴아: 드라이브 동안 날이 물을 미는 소리
    const push = this.noiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t + 0.05);
    lp.frequency.linearRampToValueAtTime(1100, t + 0.45);
    const pushG = ctx.createGain();
    pushG.gain.setValueAtTime(0.0001, t);
    pushG.gain.exponentialRampToValueAtTime(0.16 * s, t + 0.15);
    pushG.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    push.connect(lp).connect(pushG).connect(out);
    push.start(t);
    push.stop(t + 0.8);
  }

  // ---------- 물살 ----------
  startFlow(): void {
    if (!this.ctx || this.flowSrc) return;
    const ctx = this.ctx;
    this.flowSrc = this.noiseSource();
    this.flowHigh = ctx.createBiquadFilter();
    this.flowHigh.type = 'highpass';
    this.flowHigh.frequency.value = 120;
    this.flowLow = ctx.createBiquadFilter();
    this.flowLow.type = 'lowpass';
    this.flowLow.frequency.value = 300;
    this.flowGain = ctx.createGain();
    this.flowGain.gain.value = 0;
    // 잔물결처럼 크기가 천천히 출렁인다
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.6;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.15;
    const wobble = ctx.createGain();
    wobble.gain.value = 0.85;
    lfo.connect(lfoDepth).connect(wobble.gain);
    this.flowSrc.connect(this.flowHigh).connect(this.flowLow).connect(wobble).connect(this.flowGain).connect(this.master);
    this.flowSrc.start();
    lfo.start();
    this.flowSrc.onended = () => lfo.stop();
  }

  /** 배 속도(m/s)에 맞춰 물살 크기와 음색을 바꾼다. */
  /** 테스트용: 지금 물살 소리 크기 */
  get flowLevel(): number {
    return this.flowGain?.gain.value ?? 0;
  }

  setSpeed(mps: number): void {
    if (!this.ctx || !this.flowGain || !this.flowLow) return;
    const v = Math.max(0, mps);
    const k = Math.min(1, v / 5);
    const t = this.now;
    this.flowGain.gain.setTargetAtTime(0.03 + 0.3 * k * k + 0.05 * k, t, 0.15);
    this.flowLow.frequency.setTargetAtTime(320 + 1500 * k, t, 0.15);
  }

  stopFlow(): void {
    if (!this.ctx || !this.flowSrc || !this.flowGain) return;
    const src = this.flowSrc;
    this.flowGain.gain.setTargetAtTime(0, this.now, 0.2);
    src.stop(this.now + 1);
    this.flowSrc = null;
    this.flowGain = null;
    this.flowLow = null;
    this.flowHigh = null;
  }
}
