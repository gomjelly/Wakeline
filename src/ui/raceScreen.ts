// 레이스 화면: 3D 장면 + HUD + 카운트다운 + 일시정지/종료 + 결과 (FR-GAM-02~07).

import type { GameConfig, MapDefinition } from '../config';
import { Race, formatTime, type RaceSettings, type RaceSummary } from '../game/race';
import { RaceScene } from '../game/raceScene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SWATCH = ['#ff4d4d', '#2f6bff', '#1fb57a', '#ff9f1c', '#9b5de5', '#00bbf9'];

export interface RaceScreenHooks {
  /** 화면을 닫고 메인으로 돌아갈 때 */
  onExit(): void;
  /** 레이스가 끝났을 때(완주/미완주) */
  onFinish?(summary: RaceSummary, race: Race): void;
}

export class RaceScreen {
  race: Race | null = null;
  private scene: RaceScene | null = null;
  private settings: RaceSettings | null = null;
  private lastFrame = 0;
  private raf = 0;
  private quitOpen = false;
  private lastSeenPerson = performance.now();
  private toastUntil = 0;
  private passedBridges = new Set<string>();
  private lastCountdownText = '';
  private resultShown = false;

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
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  get active(): boolean {
    return this.race !== null;
  }

  start(settings: RaceSettings): void {
    this.teardown();
    this.settings = settings;
    this.race = new Race(this.cfg, settings);
    const labels = ['나', ...this.race.ais.map((_, i) => this.race!.aiName(i))];

    $('raceView').hidden = false;
    document.body.classList.add('race-mode');
    this.scene = new RaceScene($<HTMLCanvasElement>('raceCanvas'), this.map, settings.distanceM, 1 + this.race.ais.length, labels);
    $('hudTotal').textContent = String(settings.distanceM);
    $('hudBoats').textContent = String(1 + this.race.ais.length);
    this.buildProgressPips();
    ['pauseOverlay', 'quitOverlay', 'resultOverlay'].forEach((id) => ($(id).hidden = true));
    this.quitOpen = false;
    this.resultShown = false;
    this.passedBridges.clear();
    this.lastSeenPerson = performance.now();
    this.lastFrame = performance.now();
    this.loop();
  }

  /** 자세 인식 결과마다 호출 */
  onPose(t: number, index: number | null, hasPerson: boolean): void {
    if (!this.race) return;
    this.race.onPose(t, index);
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

    this.scene.render(
      [
        { distance: race.player.distance, index: race.playerIndex, driving: race.playerDriving },
        ...race.ais.map((a) => ({ distance: a.distance, index: a.index, driving: a.driving })),
      ],
      dt,
    );
    this.updateHud(now);

    if ((race.phase === 'finished' || race.phase === 'aborted') && !this.resultShown) {
      this.resultShown = true;
      const summary = race.summary();
      this.showResult(summary);
      this.hooks.onFinish?.(summary, race);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private buildProgressPips(): void {
    const bar = $('hudProgress');
    bar.innerHTML = '';
    const n = 1 + (this.race?.ais.length ?? 0);
    for (let i = n - 1; i >= 0; i--) {
      const pip = document.createElement('span');
      pip.className = `pip ${i === 0 ? 'me' : ''}`;
      pip.dataset.i = String(i);
      pip.style.background = SWATCH[i % SWATCH.length];
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
    $('hudSplit').textContent = split && split < 600 ? formatTime(split * 1000) : '-';
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
    for (const b of st) {
      const li = document.createElement('li');
      if (b.id === 'player') li.className = 'me';
      const idx = b.id === 'player' ? 0 : Number(b.id.split('-')[1]) + 1;
      const gap = b.id === 'player' ? '' : `${b.distance - me.distance >= 0 ? '+' : ''}${(b.distance - me.distance).toFixed(0)}m`;
      li.innerHTML = `<span><span class="sw" style="background:${SWATCH[idx % SWATCH.length]}"></span>${b.name}</span><span class="gap">${b.finishTimeMs !== null ? formatTime(b.finishTimeMs, true) : gap}</span>`;
      list.appendChild(li);
    }

    // 진행 막대
    for (const pip of $('hudProgress').querySelectorAll<HTMLElement>('.pip')) {
      const i = Number(pip.dataset.i);
      const dist = i === 0 ? race.player.distance : race.ais[i - 1].distance;
      pip.style.left = `${Math.min(100, (dist / total) * 100)}%`;
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
      li.textContent = `${b.name} — ${b.finishTimeMs !== null ? formatTime(b.finishTimeMs, true) : `${b.distance.toFixed(0)}m`}`;
      ol.appendChild(li);
    }
    $('resultOverlay').hidden = false;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.race || e.repeat) return;
    const phase = this.race.phase;
    const done = phase === 'finished' || phase === 'aborted';
    if (this.quitOpen) {
      if (e.code === 'Enter') this.confirmQuit();
      else if (e.code === 'Escape') this.closeQuit();
      else return;
    } else if (done) {
      if (e.code === 'KeyR') this.settings && this.start(this.settings);
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
