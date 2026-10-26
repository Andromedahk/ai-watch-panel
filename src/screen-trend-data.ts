import { DAY, type Journal } from './journal';
import type { ProviderView } from './view/model';

export type ScreenTrendSeries = { view: ProviderView; points: [number, number][] };

/** Only real percentage samples inside this viewport's time window are plotted.
 * Keep the final observation at its actual time; never extend it to "now" or
 * turn a missing quota / currency balance into a zero-percent reading. */
export function screenTrendSeries(views: ProviderView[], journal: Journal, now: number): ScreenTrendSeries[] {
  return views.flatMap(view => {
    const samples = journal.samples[view.id];
    if (!Array.isArray(samples)) return [];
    const unique = new Map<number, number>();
    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length !== 2) continue;
      const [at, value] = sample;
      if (!Number.isFinite(at) || !Number.isFinite(value) || at < now - DAY || at > now || value < 0 || value > 100) continue;
      unique.set(at, value);
    }
    const points: [number, number][] = [...unique].sort(([left], [right]) => left - right);
    return points.length ? [{ view, points }] : [];
  });
}

export function screenTrendPoint([at, value]: [number, number], now: number): [number, number] {
  // A small inset preserves the full endpoint dot at both time boundaries.
  return [1 + (at - (now - DAY)) / DAY * 98, 3 + (100 - value) / 100 * 94];
}
