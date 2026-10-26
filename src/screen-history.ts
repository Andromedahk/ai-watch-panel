import { useEffect, useRef, useState } from 'react';
import { emptyJournal, parseJournal, type Journal } from './journal';

const CHANNEL = 'ai-watch:screen-history';
type Snapshot = { kind: 'history'; remote: boolean; host: string | null; journal: Journal };

/** Only bounded, validated quota history crosses to the passive screen. */
export function parseScreenHistory(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<Snapshot>;
  if (item.kind !== 'history' || typeof item.remote !== 'boolean'
    || !(item.host === null || typeof item.host === 'string') || !item.journal) return null;
  const parsed = parseJournal(item.journal);
  return { kind: 'history', remote: item.remote, host: item.host,
    journal: { events: [], last: {}, samples: parsed.samples } };
}

export function matchingScreenHistory(snapshot: Snapshot | null, remote: boolean, host: string | null): Journal | null {
  return snapshot && snapshot.remote === remote && (!remote || snapshot.host === host) ? snapshot.journal : null;
}

/** The desktop remains the sole journal writer. A request on screen creation also
 * retrieves unsaved / remote history; subsequent changes arrive while minimized. */
export function useScreenHistory(screen: boolean, journal: Journal, remote: boolean, host: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const current = useRef({ kind: 'history' as const, remote, host, journal });
  current.current = { kind: 'history', remote, host, journal };
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const bus = new BroadcastChannel(CHANNEL);
    channel.current = bus;
    const publish = () => bus.postMessage({ ...current.current,
      journal: { samples: current.current.journal.samples } });
    bus.onmessage = event => {
      if (!screen && event.data?.kind === 'request') publish();
      else if (screen) {
        const value = parseScreenHistory(event.data);
        if (value) setSnapshot(value);
      }
    };
    if (screen) bus.postMessage({ kind: 'request' });
    else publish();
    return () => { channel.current = null; bus.close(); };
  }, [screen]);
  useEffect(() => {
    if (!screen) channel.current?.postMessage({ kind: 'history', remote, host, journal: { samples: journal.samples } });
  }, [screen, journal, remote, host]);
  if (!screen) return journal;
  // Never fill a remote chart with the local machine's persisted readings.
  return matchingScreenHistory(snapshot, remote, host) || (remote ? emptyJournal() : journal);
}
