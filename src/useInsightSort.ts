import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { InsightId } from './types';

type Rect = { left: number; top: number; width: number; height: number };
type Gesture = {
  id: InsightId; pointerId: number; x: number; y: number; clientX: number; clientY: number;
  root: HTMLElement; order: InsightId[]; rects: Rect[]; scrollTop: number; frame: number;
  active: boolean; target: number; offsetX: number; offsetY: number;
};

/** Only explicit handles start a gesture, leaving panel text and the scroller native. */
export function useInsightSort(order: InsightId[], onCommit: (order: InsightId[]) => void, disabled: boolean, onSortingChange: (sorting: boolean) => void) {
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ order, onCommit, disabled, onSortingChange });
  latest.current = { order, onCommit, disabled, onSortingChange };
  const [drag, setDrag] = useState<Gesture | null>(null);
  const finishRef = useRef<(commit: boolean) => void>(() => {});

  useEffect(() => {
    const finish = (commit: boolean) => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null; cancelAnimationFrame(g.frame); setDrag(null);
      if (g.root.hasPointerCapture(g.pointerId)) g.root.releasePointerCapture(g.pointerId);
      if (g.active) latest.current.onSortingChange(false);
      if (commit && g.active && g.target !== g.order.indexOf(g.id)) {
        const next = g.order.filter(id => id !== g.id); next.splice(g.target, 0, g.id);
        latest.current.onCommit(next);
      }
    };
    finishRef.current = finish;
    const update = () => {
      const g = gesture.current;
      if (!g?.active) return;
      const scroll = g.root.scrollTop - g.scrollTop;
      const source = g.rects[g.order.indexOf(g.id)];
      // A translated last panel must not extend the scroll range on every
      // auto-scroll frame; keep the dragged visual inside the original content.
      g.offsetX = Math.max(Math.min(...g.rects.map(rect => rect.left)) - source.left,
        Math.min(Math.max(...g.rects.map(rect => rect.left + rect.width)) - source.left - source.width, g.clientX - g.x));
      g.offsetY = Math.max(Math.min(...g.rects.map(rect => rect.top)) - source.top,
        Math.min(Math.max(...g.rects.map(rect => rect.top + rect.height)) - source.top - source.height, g.clientY - g.y + scroll));
      const x = g.clientX, y = g.clientY + scroll;
      const hit = g.rects.findIndex(rect => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height);
      const distance = (rect: Rect) => Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      g.target = hit >= 0 ? hit : g.rects.reduce((closest, rect, index) => distance(rect) < distance(g.rects[closest]) ? index : closest, 0);
      setDrag({ ...g });
    };
    const move = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) return;
      g.clientX = event.clientX; g.clientY = event.clientY;
      if (!g.active && Math.hypot(g.clientX - g.x, g.clientY - g.y) > 4) {
        g.active = true; latest.current.onSortingChange(true);
        let last = performance.now();
        const step = (time: number) => {
          if (gesture.current !== g) return;
          const bounds = g.root.getBoundingClientRect();
          const speed = g.clientY < bounds.top + 32 ? -1 : g.clientY > bounds.bottom - 32 ? 1 : 0;
          if (speed) { g.root.scrollTop += speed * Math.min(32, time - last) * .6; update(); }
          last = time; g.frame = requestAnimationFrame(step);
        };
        g.frame = requestAnimationFrame(step);
      }
      if (g.active) { event.preventDefault(); update(); }
    };
    const up = (event: PointerEvent) => { if (event.pointerId === gesture.current?.pointerId) finish(true); };
    const cancelPointer = (event: PointerEvent) => { if (event.pointerId === gesture.current?.pointerId) finish(false); };
    const lostCapture = (event: PointerEvent) => {
      const g = gesture.current;
      if (g && event.pointerId === g.pointerId && !g.root.hasPointerCapture(g.pointerId)) finish(false);
    };
    const scroll = (event: Event) => { if (gesture.current?.root === event.target) update(); };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(false); } };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer); window.addEventListener('lostpointercapture', lostCapture);
    window.addEventListener('scroll', scroll, true); window.addEventListener('blur', cancel); window.addEventListener('resize', cancel);
    window.addEventListener('keydown', key);
    return () => {
      finish(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('lostpointercapture', lostCapture);
      window.removeEventListener('scroll', scroll, true); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel);
      window.removeEventListener('keydown', key);
    };
  }, []);
  const orderKey = order.join(',');
  useEffect(() => { finishRef.current(false); }, [disabled, orderKey]);

  function start(event: ReactPointerEvent<HTMLButtonElement>, id: InsightId) {
    if (latest.current.disabled || gesture.current || latest.current.order.length < 2 || !event.isPrimary || event.button !== 0) return;
    const root = event.currentTarget.closest<HTMLElement>('.insights');
    if (!root) return;
    const panels = [...root.querySelectorAll<HTMLElement>(':scope > [data-insight]')];
    if (panels.length !== latest.current.order.length) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    const g: Gesture = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY,
      root, order: [...latest.current.order], rects: panels.map(panel => { const rect = panel.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; }),
      scrollTop: root.scrollTop, frame: 0, active: false, target: latest.current.order.indexOf(id), offsetX: 0, offsetY: 0 };
    gesture.current = g;
    try { root.setPointerCapture(event.pointerId); } catch { gesture.current = null; }
  }
  function style(id: InsightId): CSSProperties {
    return drag?.id === id ? { transform: `translate3d(${drag.offsetX}px, ${drag.offsetY}px, 0)` } : {};
  }
  return { start, style, activeId: drag?.id, targetId: drag ? drag.order[drag.target] : undefined, sorting: Boolean(drag) };
}
