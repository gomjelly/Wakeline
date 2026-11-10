// 오른쪽 패널: 고스트로 쓸 기록 고르기 + 저장한 기록 관리(이름 바꾸기·삭제·파일 내보내기/가져오기).

import {
  deleteSession,
  distanceLabel,
  exportRecords,
  formatDuration,
  getStrokes,
  importRecords,
  listSessions,
  renameSession,
  type SessionRecord,
} from '../data/records';
import { buildTimeline, type GhostSource } from '../game/ghost';
import { downloadJson, timestampName } from '../pose/recorder';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_GHOSTS = 3;

export class RecordsPanel {
  private sessions: SessionRecord[] = [];
  private checked = new Set<string>();
  private distanceM = 0;
  private mapId = 'han-river';

  constructor() {
    $('exportBtn').addEventListener('click', () => this.exportAll());
    $('importBtn').addEventListener('click', () => {
      const input = $<HTMLInputElement>('importInput');
      input.value = '';
      input.click();
    });
    $('importInput').addEventListener('change', () => this.importFile());
  }

  async refresh(distanceM = this.distanceM, mapId = this.mapId): Promise<void> {
    this.distanceM = distanceM;
    this.mapId = mapId;
    try {
      this.sessions = await listSessions();
    } catch (err) {
      console.error(err);
      this.sessions = [];
      this.status(`기록을 읽지 못했습니다: ${(err as Error).message}`);
    }
    for (const id of [...this.checked]) if (!this.ghostCandidates().some((s) => s.id === id)) this.checked.delete(id);
    this.renderGhosts();
    this.renderList();
  }

  /** 같은 맵·같은 거리이고 스트로크가 있는 기록만 고스트가 될 수 있다(FR-REC-03). */
  private ghostCandidates(): SessionRecord[] {
    return this.sessions.filter((s) => s.mapId === this.mapId && s.distanceM === this.distanceM && s.strokeCount > 0);
  }

  /** 거리별 최고 기록(완주한 것 중 가장 빠른 것) */
  private bestIds(): Set<string> {
    const best = new Map<number, SessionRecord>();
    for (const s of this.sessions) {
      if (s.status !== 'finished') continue;
      const b = best.get(s.distanceM);
      if (!b || s.totalTimeMs < b.totalTimeMs) best.set(s.distanceM, s);
    }
    return new Set([...best.values()].map((s) => s.id));
  }

  private summaryText(s: SessionRecord): string {
    const result = s.status === 'finished' ? formatDuration(s.totalTimeMs) : `미완주 ${Math.round(s.coveredM)}m`;
    return `${distanceLabel(s.distanceM)} · ${result} · ${s.strokeCount}회`;
  }

  private renderGhosts(): void {
    const box = $('ghostList');
    box.innerHTML = '';
    const list = this.ghostCandidates();
    if (!list.length) {
      box.innerHTML = `<div class="ghost-empty">${distanceLabel(this.distanceM)} 저장 기록이 아직 없습니다. 레이스를 마치고 결과 화면에서 저장하세요.</div>`;
      return;
    }
    const best = this.bestIds();
    for (const s of list) {
      const label = document.createElement('label');
      label.className = 'ghost-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.checked.has(s.id);
      cb.disabled = !cb.checked && this.checked.size >= MAX_GHOSTS;
      cb.addEventListener('change', () => {
        if (cb.checked) this.checked.add(s.id);
        else this.checked.delete(s.id);
        this.renderGhosts();
      });
      const name = document.createElement('span');
      name.textContent = `${best.has(s.id) ? '⭐ ' : ''}${s.name}`;
      const meta = document.createElement('small');
      meta.textContent = s.status === 'finished' ? formatDuration(s.totalTimeMs) : `미완주 ${Math.round(s.coveredM)}m`;
      label.append(cb, name, meta);
      box.appendChild(label);
    }
  }

  private renderList(): void {
    const ul = $('recordList');
    ul.innerHTML = '';
    if (!this.sessions.length) {
      ul.innerHTML = '<li><span class="rmeta">저장한 기록이 없습니다.</span></li>';
      return;
    }
    const best = this.bestIds();
    for (const s of this.sessions) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'rname';
      name.title = '눌러서 이름 바꾸기';
      name.textContent = `${best.has(s.id) ? '⭐ ' : ''}${s.name}`;
      name.addEventListener('click', () => this.startRename(li, name, s));
      const meta = document.createElement('span');
      meta.className = 'rmeta';
      const d = new Date(s.startedAt);
      meta.textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} · ${this.summaryText(s)}`;
      const del = document.createElement('button');
      del.className = 'rdel';
      del.textContent = '삭제';
      del.addEventListener('click', async () => {
        if (!confirm(`"${s.name}" 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await deleteSession(s.id);
        this.checked.delete(s.id);
        this.status(`"${s.name}" 기록을 삭제했습니다.`);
        await this.refresh();
      });
      li.append(name, del, meta);
      ul.appendChild(li);
    }
  }

  private startRename(li: HTMLLIElement, nameEl: HTMLSpanElement, s: SessionRecord): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.name;
    input.maxLength = 60;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      if (save && input.value.trim() && input.value.trim() !== s.name) {
        const got = await renameSession(s.id, input.value);
        this.status(got === input.value.trim() ? `이름을 "${got}"(으)로 바꿨습니다.` : `같은 이름이 있어 "${got}"(으)로 저장했습니다.`);
      }
      void li;
      await this.refresh();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private status(text: string): void {
    $('recordStatus').textContent = text;
  }

  private async exportAll(): Promise<void> {
    const data = await exportRecords();
    if (!data.sessions.length) {
      this.status('내보낼 기록이 없습니다.');
      return;
    }
    downloadJson(data, timestampName('wakeline-records'));
    this.status(`기록 ${data.sessions.length}개를 파일로 내보냈습니다.`);
  }

  private async importFile(): Promise<void> {
    const f = $<HTMLInputElement>('importInput').files?.[0];
    if (!f) return;
    try {
      const n = await importRecords(JSON.parse(await f.text()));
      this.status(`기록 ${n}개를 가져왔습니다. 이름이 겹치는 것은 번호를 붙였습니다.`);
      await this.refresh();
    } catch (err) {
      this.status(`가져오기 실패: ${(err as Error).message}`);
    }
  }

  /** 테스트용: 후보 중 최근 기록을 최대 3개 고른다. */
  selectRecent(): void {
    this.checked = new Set(this.ghostCandidates().slice(0, MAX_GHOSTS).map((s) => s.id));
    this.renderGhosts();
  }

  /** 체크한 기록을 고스트로 만든다. */
  async selectedGhosts(): Promise<GhostSource[]> {
    const out: GhostSource[] = [];
    for (const s of this.ghostCandidates().filter((x) => this.checked.has(x.id))) {
      const strokes = await getStrokes(s.id);
      out.push({
        name: s.name,
        sessionId: s.id,
        timeline: buildTimeline(strokes, s.totalTimeMs, s.coveredM),
        finishTimeMs: s.status === 'finished' ? s.totalTimeMs : null,
        coveredM: s.coveredM,
      });
    }
    return out;
  }
}
