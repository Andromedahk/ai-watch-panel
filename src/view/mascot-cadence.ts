// 看板娘 auto refresh: interval bounds and the quip / working-status rhythm.
export const MASCOT_INTERVAL_DEFAULT = 15;
export const MASCOT_INTERVAL_MIN = 5;
export const MASCOT_INTERVAL_MAX = 300;

/** 0 disables auto refresh; anything else is whole seconds within the bounds. */
export function isMascotInterval(value: unknown): value is number {
  return value === 0 || (Number.isInteger(value) && (value as number) >= MASCOT_INTERVAL_MIN && (value as number) <= MASCOT_INTERVAL_MAX);
}

/** Bring a slider or typed value into range without ever producing 0 (disabled). */
export function clampMascotInterval(value: number) {
  if (!Number.isFinite(value)) return MASCOT_INTERVAL_DEFAULT;
  return Math.min(MASCOT_INTERVAL_MAX, Math.max(MASCOT_INTERVAL_MIN, Math.round(value)));
}

/** While an agent works, every fourth auto refresh (after three quips) shows the working status. */
export function autoSlot(tick: number, working: boolean): 'quip' | 'status' {
  return working && tick > 0 && tick % 4 === 0 ? 'status' : 'quip';
}

/** Rotate which running agent the status line features. */
export function featured<T>(running: T[], turn: number): T | undefined {
  return running.length ? running[((turn % running.length) + running.length) % running.length] : undefined;
}
