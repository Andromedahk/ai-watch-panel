import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { ProviderId } from './types';

type Gesture = {
  id: ProviderId; pointerId: number; x: number; y: number; root: HTMLElement;
  order: ProviderId[]; rects: { top: number; height: number }[]; timer: number;
  active: boolean; offset: number; target: number;
};
function movedOrder(order: ProviderId[], id: ProviderId, target: number) {
  const next = order.filter(value => value !== id); next.splice(target, 0, id); return next;
}
export function useCardSort(order: ProviderId[], onCommit: (order: ProviderId[]) => void, disabled: boolean) {
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ order, onCommit, disabled }); latest.current = { order, onCommit, disabled };
  const [drag, setDrag] = useState<Gesture | null>(null);
  const finishRef = useRef<(commit: boolean) => void>(() => {});

  useEffect(() => {
    const finish = (commit: boolean) => {
      const g = gesture.current; if (!g) return;
      gesture.current = null; clearTimeout(g.timer); setDrag(null);
      if (g.root.hasPointerCapture(g.pointerId)) g.root.releasePointerCapture(g.pointerId);
      if (commit && g.active && g.target !== g.order.indexOf(g.id)) latest.current.onCommit(movedOrder(g.order, g.id, g.target));
    };
    finishRef.current = finish;
    const move = (event: PointerEvent) => {
      const g = gesture.current; if (!g || event.pointerId !== g.pointerId) return;
      if (!g.active) {
        if (Math.hypot(event.clientX - g.x, event.clientY - g.y) > 8) finish(false);
        return;
      }
      event.preventDefault();
      const from = g.order.indexOf(g.id), rect = g.rects[from];
      g.offset = Math.max(g.rects[0].top - rect.top, Math.min(g.rects[3].top - rect.top, event.clientY - g.y));
      const center = rect.top + rect.height / 2 + g.offset;
      g.target = g.rects.reduce((nearest, slot, index) => Math.abs(slot.top + slot.height / 2 - center)
        < Math.abs(g.rects[nearest].top + g.rects[nearest].height / 2 - center) ? index : nearest, 0);
      setDrag({ ...g });
    };
    const up = (event: PointerEvent) => { if (event.pointerId === gesture.current?.pointerId) finish(true); };
    const cancelPointer = (event: PointerEvent) => { if (event.pointerId === gesture.current?.pointerId) finish(false); };
    const lostCapture = (event: PointerEvent) => {
      const g = gesture.current;
      if (g && event.pointerId === g.pointerId && !g.root.hasPointerCapture(g.pointerId)) finish(false);
    };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(false); } };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('lostpointercapture', lostCapture);
    window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); window.addEventListener('keydown', key);
    return () => {
      finish(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('lostpointercapture', lostCapture);
      window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); window.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => { if (disabled) finishRef.current(false); }, [disabled]);

  function start(event: ReactPointerEvent<HTMLElement>, id: ProviderId) {
    if (latest.current.disabled || gesture.current || !event.isPrimary || event.button !== 0
      || (event.target as Element).closest('button, input, select, textarea, a, label, summary')) return;
    const root = event.currentTarget.parentElement;
    if (!root) return;
    const cards = [...root.querySelectorAll<HTMLElement>(':scope > .provider-card')];
    if (cards.length !== 4) return;
    event.preventDefault();
    const g: Gesture = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, root,
      order: [...latest.current.order], rects: cards.map(card => { const r = card.getBoundingClientRect(); return { top: r.top, height: r.height }; }),
      timer: 0, active: false, offset: 0, target: latest.current.order.indexOf(id) };
    gesture.current = g;
    try { root.setPointerCapture(event.pointerId); } catch { gesture.current = null; return; }
    g.timer = window.setTimeout(() => {
      if (gesture.current !== g || latest.current.disabled) return;
      g.active = true; setDrag({ ...g });
    }, 450);
  }
  function style(id: ProviderId): CSSProperties {
    if (!drag) return {};
    const from = drag.order.indexOf(id), to = movedOrder(drag.order, drag.id, drag.target).indexOf(id);
    const offset = id === drag.id ? drag.offset : drag.rects[to].top - drag.rects[from].top;
    return { transform: `translate3d(0, ${offset}px, 0)${id === drag.id ? ' scale(1.01)' : ''}` };
  }
  return { start, style, activeId: drag?.id, target: drag?.target, sorting: Boolean(drag) };
}
