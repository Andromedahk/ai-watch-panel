import { useEffect, useState, type RefObject } from 'react';
import type { ProviderId } from './types';

export function useVisibleCards(viewport: RefObject<HTMLDivElement | null>, ids: ProviderId[], collapsed: boolean, testing: boolean) {
  const [visible, setVisible] = useState<Set<ProviderId>>(new Set());
  const key = ids.join(',');
  useEffect(() => {
    const root = viewport.current;
    if (!root || collapsed) { setVisible(new Set()); return; }
    const current = new Set<ProviderId>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.provider as ProviderId;
        if (entry.intersectionRatio >= .6) current.add(id); else current.delete(id);
      }
      setVisible(new Set(current));
    }, { root, threshold: [0, .6, 1] });
    root.querySelectorAll('.provider-card').forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [viewport, key, collapsed, testing]);
  return visible;
}
