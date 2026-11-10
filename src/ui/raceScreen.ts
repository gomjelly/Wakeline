// 레이스 화면: 3D 장면 + HUD + 카운트다운 + 일시정지/종료 + 결과·기록 저장 (FR-GAM-02~07, FR-REC-01~03).

import type { GameConfig, MapDefinition } from '../config';
import { defaultRecordName, distanceLabel, saveRace, shortName, type SessionRecord } from '../data/records';
import { Race, formatTime, type RaceSettings, type RaceSummary } from '../game/race';
import { RaceScene, type BoatSpec } from '../game/raceScene';
import { RaceSound } from '../game/sound';
import { IndexGraph } from './graph';
import type { RacePhase } from '../game/race';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SWATCH = ['#ff4d4d', '#2f6bff', '#1fb57a', '#ff9f1c', '#9b5de5', '#00bbf9'];
const GHOST_SWATCH = '#bfe6ff';

export interface RaceScreenHooks {
  /** 화면을 닫고 메인으로 돌아갈 때 */
  onExit(): void;
  /** 레이스가 끝났을 때(완주/미완주) */
  onFinish?(summary: RaceSummary, race: Race): void;
  /** 기록을 저장했을 때 */
  onSaved?(record: SessionRecord): void;
  /** 레이스 중 M 키로 음소거를 바꿨을 때 */
  onMuteChange?(muted: boolean): void;
}

interface BoatView {
  id: string;
  color: string;
  distance: () => number;
}

export class RaceScreen {
  race: Race | null = null;
  /** 테스트용: 결과가 나오면 바로 저장 */
  autoSave = false;
  private scene: RaceScene | null = null;
  private settings: RaceSettings | null = null;
  private startedAt = new Date();
  private views: BoatView[] = [];
  private ghostLabels: string[] = [];
  private lastFrame = 0;
  private raf = 0;
  private quitOpen = false;
  private lastSeenPerson = performance.now();
  private toastUntil = 0;
  private passedBridges = new Set<string>();
  private lastCountdownText = '';
  private resultShown = false;
  private saved: SessionRecord | null = null;
  private saving = false;
  readonly sound = new RaceSound();
  private graph: IndexGraph;
  private graphOn = (() => {
    try {
      return localStorage.getItem('wakeline.raceGraph') !== '0';
    } catch {
      return true;
    }
  })();
  private prevPhase: RacePhase = 'countdown';
  private lastBeepSec = 0;
  private prevStrokePhase = 'recovery';
  private prevRivalDriving: boolean[] = [];

  constructor(
    private cfg: GameConfig,
    private map: MapDefinition,
    private hooks: RaceScreenHooks,
  ) {
    $('resumeBtn').addEventListener('click', () => this.resume());
    $('pauseQuitBtn').addEventListener('click', () => this.openQuit());
    $('quitConfirmBtn').addEventListener('click', () => this.confirmQuit());
    $('quitCancelBtn').addEventListener('click', () => this.closeQuit());
    $('againBtn').addEventListener('click', () => this.settings && this.start(this.settings));
    $('homeBtn').addEventListener('click', () => this.exit());
    $('saveBtn').addEventListener('click', () => this.save());
    this.graph = new IndexGraph($<HTMLCanvasElement>('raceGraph'), 8000, cfg.detection.catchThreshold, cfg.detection.finishThreshold);
    $('raceGraphWrap').hidden = !this.graphOn;
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  get active(): boolean {
    return this.race !== null;
  }

  start(settings: RaceSettings): void {
    this.teardown();
    this.settings = settings;
    this.startedAt = new Date();
    const race = (this.race = new Race(this.cfg, settings));
    // 고스트 이름표는 늘 구분되게 한다:
    //  - 줄인 이름이 서로 겹치면 줄이지 않는다
    //  - AI 이름과 같으면 "(기록)"을 붙인다
    const aiNames = new Set(race.ais.map((_, i) => race.aiName(i)));
    const shorts = race.ghosts.map((g) => shortName(g.src.name));
    this.ghostLabels = race.ghosts.map((g, i) => {
      const label = shorts.filter((x) => x === shorts[i]).length > 1 ? g.src.name : shorts[i];
      return aiNames.has(label) ? `${label} (기록)` : label;
    });

    const specs: BoatSpec[] = [
      { label: '나' },
      ...race.ais.map((_, i) => ({ label: race.aiName(i) })),
      ...this.ghostLabels.map((label) => ({ label: `👻 ${label}`, ghost: true })),
    ];
    this.views = [
      { id: 'player', color: SWATCH[0], distance: () => race.player.distance },
      ...race.ais.map((a, i) => ({ id: `ai-${i}`, color: SWATCH[(i + 1) % SWATCH.length], distance: () => a.distance })),
      ...race.ghosts.map((g, i) => ({ id: `ghost-${i}`, color: GHOST_SWATCH, distance: () => g.distance })),
    ];

    $('raceView').hidden = false;
    document.body.classList.add('race-mode');
    this.scene = new RaceScene($<HTMLCanvasElement>('raceCanvas'), this.map, settings.distanceM, specs);
    $('hudTotal').textContent = String(settings.distanceM);
    $('hudBoats').textContent = String(specs.length);
    this.buildProgressPips();
    ['pauseOverlay', 'quitOverlay', 'resultOverlay'].forEach((id) => ($(id).hidden = true));
    this.quitOpen = false;
    this.resultShown = false;
    this.saved = null;
    this.passedBridges.clear();
    this.lastSeenPerson = performance.now();
    this.lastFrame = performance.now();
    this.prevPhase = race.phase;
    this.lastBeepSec = 0;
    this.prevStrokePhase = 'recovery';
    this.prevRivalDriving = [];
    this.sound.ensure().then(() => this.sound.startFlow()).catch((err) => console.warn('소리를 켤 수 없습니다', err));
    this.loop();
  }

  /** 자세 인식 결과마다 호출 */
  onPose(t: number, index: number | null, hasPerson: boolean, kneeDeg: number | null = null): void {
    if (!this.race) return;
    this.race.onPose(t, index);
    this.graph.push({ t: performance.now(), index, knee: kneeDeg });
    if (hasPerson) this.lastSeenPerson = t;
  }

  private loop = (): void => {
    if (!this.race || !this.scene) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const race = this.race;
    // 사람이 한동안 안 보이거나 영상이 끊기면 자동 일시정지 (FR-CAM-05).
    // 영상 프레임이 아예 안 들어오는 경우도 잡도록 프레임 콜백이 아니라 여기서 검사한다.
    if (race.phase === 'racing' && now - this.lastSeenPerson > this.cfg.detection.lostPersonPauseMs) {
      this.pause('사람이 보이지 않아 일시정지했습니다. 카메라 앞으로 돌아온 뒤 스페이스를 누르세요.');
    }
    race.tick(dt, now);
    this.updateSound();

    this.scene.render(
      [
        { distance: race.player.distance, index: race.playerIndex, driving: race.playerDriving },
        ...race.ais.map((a) => ({ distance: a.distance, index: a.index, driving: a.driving })),
        ...race.ghosts.map((g) => ({ distance: g.distance, index: g.index, driving: g.driving })),
      ],
      dt,
    );
    this.updateHud(now);
    if (this.graphOn) this.graph.draw(now);

    if ((race.phase === 'finished' || race.phase === 'aborted') && !this.resultShown) {
      this.resultShown = true;
      const summary = race.summary();
      this.showResult(summary);
      this.hooks.onFinish?.(summary, race);
      if (this.autoSave) this.save();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** 레이스 상태 변화에 맞춰 효과음을 낸다. */
  private updateSound(): void {
    const race = this.race!;
    const snd = this.sound;
    const phase = race.phase;

    // 카운트다운: 숫자가 바뀔 때마다 삑
    if (phase === 'countdown' || phase === 'resume') {
      const sec = Math.ceil(race.countdownMs / 1000);
      if (sec !== this.lastBeepSec && sec > 0) {
        this.lastBeepSec = sec;
        snd.beep();
      }
    } else this.lastBeepSec = 0;

    // 출발: 처음에는 시작 휘슬, 일시정지 후 재개할 때는 높은 삑
    if (phase === 'racing' && this.prevPhase !== 'racing') {
      if (this.prevPhase === 'countdown') snd.startWhistle();
      else if (this.prevPhase === 'resume') snd.beep(true);
    }
    // 결승: 종료 휘슬
    if (phase === 'finished' && this.prevPhase !== 'finished') snd.finishWhistle();
    this.prevPhase = phase;

    // 물살: 배 속도에 따라
    snd.setSpeed(phase === 'paused' ? 0 : race.player.speed);

    if (phase !== 'racing') {
      this.prevStrokePhase = race.detector.phase;
      return;
    }

    // 내 노: 스트로크 감지기가 드라이브에 들어가는 순간(노가 물을 잡는 순간)
    const sp = race.detector.phase;
    if (sp === 'drive' && this.prevStrokePhase !== 'drive') {
      const last = race.strokes[race.strokes.length - 1];
      snd.stroke(last ? last.length : 0.8, 0, 1);
    }
    this.prevStrokePhase = sp;

    // 다른 배들의 노: 가까울수록 크게, 레인 방향(좌우)에 맞춰
    const rivals = [
      ...race.ais.map((a) => ({ driving: a.driving, distance: a.distance })),
      ...race.ghosts.map((g) => ({ driving: g.driving, distance: g.distance })),
    ];
    rivals.forEach((r, i) => {
      const was = this.prevRivalDriving[i] ?? false;
      if (r.driving && !was) {
        const dz = r.distance - race.player.distance;
        const dx = this.scene?.laneOffset(i + 1) ?? 0;
        const level = 0.4 * Math.max(0, 1 - Math.hypot(dx, dz) / 45);
        snd.stroke(0.6, dx / 30, level);
      }
      this.prevRivalDriving[i] = r.driving;
    });
  }

  private buildProgressPips(): void {
    const bar = $('hudProgress');
    bar.innerHTML = '';
    // 플레이어 점이 맨 위에 오도록 마지막에 붙인다.
    for (const v of [...this.views].reverse()) {
      const pip = document.createElement('span');
      pip.className = `pip ${v.id === 'player' ? 'me' : ''} ${v.id.startsWith('ghost') ? 'ghost' : ''}`;
      pip.dataset.id = v.id;
      pip.style.background = v.color;
      bar.appendChild(pip);
    }
  }

  private updateHud(now: number): void {
    const race = this.race!;
    const total = race.settings.distanceM;
    const d = Math.min(race.player.distance, total);
    $('hudDist').textContent = d.toFixed(0);
    $('hudBar').style.width = `${(d / total) * 100}%`;
    $('hudTime').textContent = formatTime(race.phase === 'finished' && race.finishTimeMs ? race.finishTimeMs : race.elapsedMs, true);
    const split = race.splitSec;
    $('hudSplit').textContent = split && split < 900 ? formatTime(split * 1000) : '-';
    $('hudSpm').textContent = race.spm ? race.spm.toFixed(0) : '0';
    $('hudStrokes').textContent = String(race.strokes.length);
    $('hudSpeed').textContent = `${race.player.speed.toFixed(1)}`;
    $('hudRemain').textContent = `${Math.max(0, total - d).toFixed(0)}m`;

    // 순위와 격차
    const st = race.standings();
    const me = st.find((b) => b.id === 'player')!;
    $('hudRank').textContent = String(st.indexOf(me) + 1);
    const list = $('hudStandings');
    list.innerHTML = '';
    // 카메라 창 위 남은 높이만큼만 줄을 보여준다. 넘치면 위쪽 순위 + 내 줄을 남기고 사이를 "⋯"로 줄인다.
    const camH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cam-h')) || 300;
    const rows = Math.max(2, Math.floor((window.innerHeight - camH - 64 - 100) / 27));
    const myIdx = st.indexOf(me);
    let shown = st.map((_, i) => i);
    if (st.length > rows) {
      const top = st.slice(0, rows - 1).map((_, i) => i);
      shown = myIdx < rows - 1 ? st.slice(0, rows).map((_, i) => i) : [...top.slice(0, rows - 2), myIdx - 1, myIdx].filter((v, i, a) => a.indexOf(v) === i);
    }
    let prev = -1;
    for (const i of shown) {
      const b = st[i];
      if (i > prev + 1) {
        const gapLi = document.createElement('li');
        gapLi.className = 'more';
        gapLi.textContent = '⋯';
        list.appendChild(gapLi);
      }
      prev = i;
      const li = document.createElement('li');
      if (b.id === 'player') li.className = 'me';
      else if (b.id.startsWith('ghost')) li.className = 'ghost';
      const color = this.views.find((v) => v.id === b.id)?.color ?? '#fff';
      const gap = b.id === 'player' ? '' : `${b.distance - me.distance >= 0 ? '+' : ''}${(b.distance - me.distance).toFixed(0)}m`;
      const name = b.id.startsWith('ghost') ? `👻 ${this.ghostLabels[Number(b.id.split('-')[1])]}` : b.name;
      li.innerHTML = `<span class="nm"><span class="sw" style="background:${color}"></span><span></span></span><span class="gap">${b.finishTimeMs !== null ? formatTime(b.finishTimeMs, true) : gap}</span>`;
      li.querySelector('.nm span:last-child')!.textContent = name;
      list.appendChild(li);
    }

    // 진행 막대
    for (const pip of $('hudProgress').querySelectorAll<HTMLElement>('.pip')) {
      const v = this.views.find((x) => x.id === pip.dataset.id);
      if (v) pip.style.left = `${Math.min(100, (v.distance() / total) * 100)}%`;
    }

    // 카운트다운
    const cd = $('hudCountdown');
    let text = '';
    if (race.phase === 'countdown' || race.phase === 'resume') text = String(Math.ceil(race.countdownMs / 1000));
    else if (race.phase === 'racing' && race.elapsedMs < 900 && race.strokes.length === 0) text = 'GO!';
    if (text !== this.lastCountdownText) {
      this.lastCountdownText = text;
      cd.hidden = !text;
      cd.textContent = text;
      cd.classList.toggle('go', text === 'GO!');
    }

    // 다리 통과 알림
    for (const b of this.map.bridges) {
      if (b.distanceM < total && race.player.distance >= b.distanceM && !this.passedBridges.has(b.name)) {
        this.passedBridges.add(b.name);
        this.toast(`${b.name} 통과 · ${formatTime(race.elapsedMs, true)}`, now);
      }
    }
    if (now > this.toastUntil) $('hudToast').hidden = true;
  }

  private toast(text: string, now: number): void {
    const t = $('hudToast');
    t.textContent = text;
    t.hidden = false;
    this.toastUntil = now + 2500;
  }

  pause(reason = ''): void {
    if (!this.race) return;
    if (this.race.phase !== 'racing' && this.race.phase !== 'resume' && this.race.phase !== 'countdown') return;
    this.race.pause();
    $('pauseReason').textContent = reason;
    $('pauseOverlay').hidden = false;
  }

  resume(): void {
    if (!this.race || this.race.phase !== 'paused') return;
    $('pauseOverlay').hidden = true;
    this.lastSeenPerson = performance.now();
    this.race.resume();
  }

  private openQuit(): void {
    if (!this.race || this.race.phase === 'finished' || this.race.phase === 'aborted') return;
    this.race.pause();
    $('pauseOverlay').hidden = true;
    $('quitOverlay').hidden = false;
    this.quitOpen = true;
  }

  private closeQuit(): void {
    $('quitOverlay').hidden = true;
    this.quitOpen = false;
    this.race?.resume();
  }

  private confirmQuit(): void {
    $('quitOverlay').hidden = true;
    this.quitOpen = false;
    this.race?.abort();
  }

  private showResult(s: RaceSummary): void {
    const race = this.race!;
    $('pauseOverlay').hidden = true;
    $('resultTitle').textContent = s.status === 'finished' ? '완주!' : '미완주';
    $('resultRank').textContent = s.status === 'finished' ? `${s.rank}위 / ${s.boats}` : `${s.distanceM.toFixed(0)}m`;
    const stat = (k: string, v: string) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`;
    $('resultStats').innerHTML = [
      stat('기록', formatTime(s.totalTimeMs, true)),
      stat('평균 스플릿', s.avgSplitSec ? formatTime(s.avgSplitSec * 1000, true) : '-'),
      stat('평균 SPM', s.avgSpm.toFixed(1)),
      stat('스트로크', String(s.strokeCount)),
      stat('거리', `${s.distanceM.toFixed(0)}m`),
      stat('칼로리(추정)', `${s.caloriesKcal.toFixed(0)}kcal`),
    ].join('');
    const ol = $('resultStandings');
    ol.innerHTML = '';
    for (const b of race.standings()) {
      const li = document.createElement('li');
      if (b.id === 'player') li.className = 'me';
      const name = b.id.startsWith('ghost') ? `👻 ${b.name}` : b.name;
      li.textContent = `${name} — ${b.finishTimeMs !== null ? formatTime(b.finishTimeMs, true) : `${b.distance.toFixed(0)}m`}`;
      ol.appendChild(li);
    }

    // 기록 저장 칸
    const input = $<HTMLInputElement>('saveName');
    input.value = defaultRecordName(this.startedAt, race.settings.distanceM, s);
    input.disabled = false;
    // 완주한 레이스만 저장할 수 있다(미완주 기록은 고스트·최고 기록 비교에 맞지 않음).
    const canSave = s.status === 'finished' && s.strokeCount > 0;
    $<HTMLButtonElement>('saveBtn').disabled = !canSave;
    $<HTMLInputElement>('saveName').disabled = !canSave;
    $('saveStatus').textContent = canSave
      ? `${distanceLabel(race.settings.distanceM)} 기록으로 저장됩니다.`
      : '완주한 기록만 저장할 수 있어요.';
    $('resultOverlay').hidden = false;
  }

  private async save(): Promise<void> {
    const race = this.race;
    if (!race || this.saved || this.saving || !this.resultShown) return;
    const s = race.summary();
    if (s.status !== 'finished' || s.strokeCount === 0) return;
    this.saving = true;
    const btn = $<HTMLButtonElement>('saveBtn');
    btn.disabled = true;
    try {
      const rec = await saveRace($<HTMLInputElement>('saveName').value, this.startedAt, race.settings, s, race.strokes);
      this.saved = rec;
      $<HTMLInputElement>('saveName').value = rec.name;
      $<HTMLInputElement>('saveName').disabled = true;
      $('saveStatus').textContent = `✓ ${distanceLabel(rec.distanceM)} 기록 "${rec.name}"(으)로 저장했습니다. 다음 ${distanceLabel(rec.distanceM)} 레이스에서 고스트로 불러올 수 있어요.`;
      this.hooks.onSaved?.(rec);
    } catch (err) {
      btn.disabled = false;
      $('saveStatus').textContent = `저장 실패: ${(err as Error).message}`;
    } finally {
      this.saving = false;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.race || e.repeat) return;
    // 이름 입력 중에는 Enter로 저장만 받는다.
    if (e.target instanceof HTMLInputElement) {
      if (e.code === 'Enter' && e.target.id === 'saveName') {
        e.preventDefault();
        this.save();
      }
      return;
    }
    const phase = this.race.phase;
    const done = phase === 'finished' || phase === 'aborted';
    if (e.code === 'KeyG') {
      this.graphOn = !this.graphOn;
      $('raceGraphWrap').hidden = !this.graphOn;
      try {
        localStorage.setItem('wakeline.raceGraph', this.graphOn ? '1' : '0');
      } catch {
        /* 무시 */
      }
    } else if (e.code === 'KeyM') {
      this.sound.setMuted(!this.sound.muted);
      this.toast(this.sound.muted ? '🔇 소리 끔 (M)' : '🔊 소리 켬 (M)', performance.now());
      this.hooks.onMuteChange?.(this.sound.muted);
    } else if (this.quitOpen) {
      if (e.code === 'Enter') this.confirmQuit();
      else if (e.code === 'Escape') this.closeQuit();
      else return;
    } else if (done) {
      if (e.code === 'KeyR') this.settings && this.start(this.settings);
      else if (e.code === 'KeyS') this.save();
      else if (e.code === 'Escape') this.exit();
      else return;
    } else if (e.code === 'Space') {
      if (phase === 'paused') this.resume();
      else this.pause();
    } else if (e.code === 'Escape') {
      this.openQuit();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private teardown(): void {
    cancelAnimationFrame(this.raf);
    this.sound.stopFlow();
    this.scene?.dispose();
    this.scene = null;
    this.race = null;
  }

  exit(): void {
    this.teardown();
    $('raceView').hidden = true;
    document.body.classList.remove('race-mode');
    this.hooks.onExit();
  }
}
