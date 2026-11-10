// 레이스 기록 저장소 (SRS 5장). 브라우저 IndexedDB: sessions(레이스 1회), strokes(스트로크 1회).
// Electron에서는 앱 사용자 폴더에 저장되어 다시 실행해도 남는다.

import type { RaceSettings, RaceStroke, RaceSummary } from '../game/race';

export interface SessionRecord {
  id: string;
  /** 기록 이름. 저장소 안에서 겹치지 않는다. */
  name: string;
  startedAt: string;
  endedAt: string;
  mapId: string;
  distanceM: number;
  difficulty: string;
  opponent: string;
  status: 'finished' | 'aborted';
  totalTimeMs: number;
  /** 실제로 간 거리 */
  coveredM: number;
  strokeCount: number;
  avgSpm: number;
  avgSplitSec: number;
  caloriesKcal: number;
  rank: number;
}

export interface StrokeRecord {
  sessionId: string;
  index: number;
  tMs: number;
  distanceM: number;
  length: number;
  driveMs: number;
  recoveryMs: number;
  spm: number;
  power: number;
}

export interface RecordExport {
  app: 'wakeline';
  version: 1;
  exportedAt: string;
  sessions: SessionRecord[];
  strokes: StrokeRecord[];
}

const DB_NAME = 'wakeline';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains('strokes')) {
        const s = db.createObjectStore('strokes', { keyPath: ['sessionId', 'index'] });
        s.createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await openDb();
  const all = await req(db.transaction('sessions').objectStore('sessions').getAll() as IDBRequest<SessionRecord[]>);
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getStrokes(sessionId: string): Promise<StrokeRecord[]> {
  const db = await openDb();
  const idx = db.transaction('strokes').objectStore('strokes').index('sessionId');
  const rows = await req(idx.getAll(sessionId) as IDBRequest<StrokeRecord[]>);
  return rows.sort((a, b) => a.index - b.index);
}

/** 이름이 겹치면 뒤에 (2), (3)…을 붙여 고유하게 만든다. */
export function uniqueName(wanted: string, taken: Iterable<string>, ignoreId?: string, sessions?: SessionRecord[]): string {
  const used = new Set<string>();
  if (sessions) for (const s of sessions) if (s.id !== ignoreId) used.add(s.name);
  for (const t of taken) used.add(t);
  const base = wanted.trim() || '기록';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!used.has(n)) return n;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function distanceLabel(m: number): string {
  return m >= 1000 ? `${+(m / 1000).toFixed(2)}km` : `${m}m`;
}

/** 기본 기록 이름: "11/10 22:40 9:02.3" (거리는 목록에 따로 보이므로 이름에서는 뺀다) */
export function defaultRecordName(startedAt: Date, _distanceM: number, summary: RaceSummary): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${startedAt.getMonth() + 1}/${startedAt.getDate()} ${p(startedAt.getHours())}:${p(startedAt.getMinutes())}`;
  const result = summary.status === 'finished' ? formatDuration(summary.totalTimeMs) : `미완주${summary.distanceM.toFixed(0)}m`;
  return `${when} ${result}`;
}

/** 화면 위 이름표처럼 좁은 곳에 쓸 짧은 이름 */
export function shortName(name: string, max = 16): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export async function saveRace(
  name: string,
  startedAt: Date,
  settings: RaceSettings,
  summary: RaceSummary,
  strokes: RaceStroke[],
): Promise<SessionRecord> {
  const sessions = await listSessions();
  const id = crypto.randomUUID();
  const session: SessionRecord = {
    id,
    name: uniqueName(name, [], undefined, sessions),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    mapId: settings.mapId,
    distanceM: settings.distanceM,
    difficulty: settings.difficulty,
    opponent: settings.opponent,
    status: summary.status,
    totalTimeMs: Math.round(summary.totalTimeMs),
    coveredM: Math.round(summary.distanceM * 10) / 10,
    strokeCount: summary.strokeCount,
    avgSpm: Math.round(summary.avgSpm * 10) / 10,
    avgSplitSec: Math.round(summary.avgSplitSec * 10) / 10,
    caloriesKcal: Math.round(summary.caloriesKcal),
    rank: summary.rank,
  };
  const rows: StrokeRecord[] = strokes.map((s) => ({
    sessionId: id,
    index: s.index,
    tMs: Math.round(s.tRace),
    distanceM: Math.round(s.distanceM * 100) / 100,
    length: Math.round(s.length * 1000) / 1000,
    driveMs: Math.round(s.driveMs),
    recoveryMs: Math.round(s.recoveryMs),
    spm: Math.round(s.spm * 10) / 10,
    power: Math.round(s.power * 1000) / 1000,
  }));
  await putAll([session], rows);
  return session;
}

async function putAll(sessions: SessionRecord[], strokes: StrokeRecord[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'strokes'], 'readwrite');
  for (const s of sessions) tx.objectStore('sessions').put(s);
  for (const s of strokes) tx.objectStore('strokes').put(s);
  await done(tx);
}

export async function renameSession(id: string, wanted: string): Promise<string> {
  const db = await openDb();
  const sessions = await listSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new Error('기록을 찾을 수 없습니다');
  s.name = uniqueName(wanted, [], id, sessions);
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(s);
  await done(tx);
  return s.name;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  const strokes = await getStrokes(id);
  const tx = db.transaction(['sessions', 'strokes'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  for (const s of strokes) tx.objectStore('strokes').delete([s.sessionId, s.index]);
  await done(tx);
}

export async function exportRecords(ids?: string[]): Promise<RecordExport> {
  const sessions = (await listSessions()).filter((s) => !ids || ids.includes(s.id));
  const strokes: StrokeRecord[] = [];
  for (const s of sessions) strokes.push(...(await getStrokes(s.id)));
  return { app: 'wakeline', version: 1, exportedAt: new Date().toISOString(), sessions, strokes };
}

/** 가져온 기록은 새 ID를 받고, 이름이 겹치면 고유하게 바꾼다. 가져온 개수를 돌려준다. */
export async function importRecords(data: unknown): Promise<number> {
  const d = data as Partial<RecordExport>;
  if (d?.app !== 'wakeline' || !Array.isArray(d.sessions) || !Array.isArray(d.strokes)) {
    throw new Error('Wakeline 기록 파일이 아닙니다');
  }
  const existing = await listSessions();
  const names = existing.map((s) => s.name);
  const sessions: SessionRecord[] = [];
  const strokes: StrokeRecord[] = [];
  for (const s of d.sessions) {
    const id = crypto.randomUUID();
    const name = uniqueName(s.name, names);
    names.push(name);
    sessions.push({ ...s, id, name });
    for (const st of d.strokes) if (st.sessionId === s.id) strokes.push({ ...st, sessionId: id });
  }
  await putAll(sessions, strokes);
  return sessions.length;
}
