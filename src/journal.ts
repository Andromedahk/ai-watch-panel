// Activity journal for the lower-half panels: state changes per assistant and
// the tightest remaining quota over time. Only provider ids, states, waiting
// reasons, timestamps and percentages are kept — never task titles, prompts or
// paths. The live journal stays in this renderer's local storage on this
// device; test mode uses a separate in-memory journal seeded with sample data.
import type { LocalProviderStatus, LocalStatus, ProviderId } from './types';

export type JournalState = 'running' | 'waiting' | 'idle' | 'offline';
export type JournalEvent = { at: number; id: ProviderId; from: JournalState; to: JournalState; reason?: 'input' | 'approval' | 'both' };
export type Journal = { events: JournalEvent[]; samples: Partial<Record<ProviderId, [number, number][]>>; last: Partial<Record<ProviderId, JournalState>> };

export const DAY = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 300, MAX_SAMPLES = 300;
const MERGE_MS = 15000; // flapping within this window collapses into one change
const SAMPLE_MS = 10 * 60 * 1000; // an unchanged value is re-sampled at most every 10 minutes
const KEY = 'ai-watch:journal';
const IDS: ProviderId[] = ['claude', 'codex', 'antigravity', 'deepseek', 'zcode', 'kimi', 'qwen', 'workbuddy'];
const STATES = new Set<JournalState>(['running', 'waiting', 'idle', 'offline']);

export const emptyJournal = (): Journal => ({ events: [], samples: {}, last: {} });

/** The lowest known, current remaining percentage of an assistant, or null. */
export function tightestRemaining(status: LocalProviderStatus | undefined) {
  if (!status) return null;
  const values = (status.quotas || []).filter(quota => quota.remaining !== null && !quota.stale).map(quota => quota.remaining!);
  for (const item of status.credits?.stale ? [] : status.credits?.items || []) {
    const remaining = Number(item.remaining), total = Number(item.total);
    if (item.remaining !== null && item.total && Number.isFinite(remaining) && Number.isFinite(total) && total > 0) values.push(Math.max(0, Math.min(100, remaining / total * 100)));
  }
  return values.length ? Math.round(Math.min(...values) * 10) / 10 : null;
}

/** Record one status sample. Returns a new journal when something changed, otherwise the same object. */
export function record(journal: Journal, status: LocalStatus, now = Date.now()): Journal {
  let events = journal.events, samples = journal.samples, last = journal.last, changed = false, copied = false;
  for (const id of IDS) {
    const item = status[id];
    if (!item) continue;
    const state = item.activity === 'unknown' ? null : item.activity as JournalState;
    if (state) {
      const previous = last[id];
      const reason = state === 'waiting' ? item.waitingReason : undefined;
      const previousEvent = [...events].reverse().find(event => event.id === id);
      const reasonChanged = state === 'waiting' && previous === 'waiting' && previousEvent?.to === 'waiting' && previousEvent.reason !== reason;
      if (previous && (previous !== state || reasonChanged)) {
        if (!copied) { events = [...events]; copied = true; }
        const index = events.lastIndexOf(previousEvent!);
        if (previousEvent && index >= 0 && now - previousEvent.at < MERGE_MS) {
          // A quick flip replaces the last change; flipping straight back removes it.
          if (previousEvent.from === state && !reason) events.splice(index, 1);
          else events[index] = { ...previousEvent, at: now, to: state, reason };
        } else events.push({ at: now, id, from: previous, to: state, ...(reason ? { reason } : {}) });
        changed = true;
      }
      if (previous !== state) { last = { ...last, [id]: state }; changed = true; }
    }
    const value = tightestRemaining(item);
    if (value !== null) {
      const series = samples[id] || [], tail = series[series.length - 1];
      if (!tail || tail[1] !== value || now - tail[0] >= SAMPLE_MS) {
        samples = { ...samples, [id]: [...series, [now, value] as [number, number]].filter(([at]) => now - at <= DAY).slice(-MAX_SAMPLES) };
        changed = true;
      }
    }
  }
  if (!changed) return journal;
  return { events: events.filter(event => now - event.at <= DAY).slice(-MAX_EVENTS), samples, last };
}

function validEvent(value: unknown): value is JournalEvent {
  const event = value as JournalEvent;
  return Boolean(event) && Number.isFinite(event.at) && IDS.includes(event.id) && STATES.has(event.from) && STATES.has(event.to)
    && (event.reason === undefined || ['input', 'approval', 'both'].includes(event.reason));
}
export function loadJournal(now = Date.now()): Journal {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!value || typeof value !== 'object') return emptyJournal();
    const events = Array.isArray(value.events) ? value.events.filter(validEvent).filter((event: JournalEvent) => now - event.at <= DAY).slice(-MAX_EVENTS) : [];
    const samples: Journal['samples'] = {};
    for (const id of IDS) {
      const series = value.samples?.[id];
      if (Array.isArray(series)) samples[id] = series.filter((row: unknown) => Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]) && now - row[0] <= DAY)
        .map((row: number[]) => [row[0], Math.max(0, Math.min(100, row[1]))] as [number, number]).slice(-MAX_SAMPLES);
    }
    // States are not restored: a restart starts a fresh baseline instead of inventing a change across the gap.
    return { events, samples, last: {} };
  } catch { return emptyJournal(); }
}
export function saveJournal(journal: Journal) {
  try { localStorage.setItem(KEY, JSON.stringify({ events: journal.events, samples: journal.samples })); } catch { /* storage is a convenience only */ }
}

/** Sample history for test mode, so every panel has something to show. */
export function demoJournal(now = Date.now()): Journal {
  const minute = 60000, events: JournalEvent[] = [];
  const add = (ago: number, id: ProviderId, from: JournalState, to: JournalState, reason?: JournalEvent['reason']) =>
    events.push({ at: now - ago * minute, id, from, to, ...(reason ? { reason } : {}) });
  add(205, 'kimi', 'offline', 'idle'); add(190, 'kimi', 'idle', 'running'); add(150, 'kimi', 'running', 'idle');
  add(120, 'antigravity', 'idle', 'running'); add(96, 'codex', 'idle', 'running'); add(70, 'codex', 'running', 'waiting', 'approval');
  add(66, 'codex', 'waiting', 'running'); add(52, 'antigravity', 'running', 'idle'); add(41, 'claude', 'idle', 'running');
  add(28, 'claude', 'running', 'waiting', 'input'); add(25, 'claude', 'waiting', 'running'); add(12, 'zcode', 'idle', 'running');
  add(6, 'codex', 'running', 'idle');
  const samples: Journal['samples'] = {};
  const curve = (id: ProviderId, start: number, end: number, resetAgo?: number) => {
    const rows: [number, number][] = [];
    for (let ago = 24 * 60; ago >= 0; ago -= 30) {
      const t = 1 - ago / (24 * 60);
      let value = start + (end - start) * t + Math.sin(t * 9) * 3;
      if (resetAgo !== undefined && ago < resetAgo) value = 100 - (resetAgo - ago) / resetAgo * (100 - end);
      rows.push([now - ago * minute, Math.round(Math.max(0, Math.min(100, value)))]);
    }
    samples[id] = rows;
  };
  curve('claude', 96, 41); curve('codex', 88, 62, 300); curve('antigravity', 100, 74); curve('zcode', 90, 23); curve('kimi', 80, 55, 600);
  return { events, samples, last: {} };
}
