export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'deepseek';
export type Preferences = { side: 'left' | 'right'; locked: boolean; animate: boolean };
export type PanelState = Preferences & {
  collapsed: boolean; desktop: boolean; platform: string; scaleFactor: number;
  bounds?: { x: number; y: number; width: number; height: number };
};
export type Quota = { model: string; period: string; remaining: number; reset: string };
export type Provider = {
  id: ProviderId; name: string; subtitle: string; color: string; running: boolean;
  task: string; quotas: Quota[]; image: string;
};
declare global {
  interface Window {
    panel?: {
      getState(): Promise<PanelState>;
      setLocked(locked: boolean): Promise<PanelState>;
      setCollapsed(collapsed: boolean): Promise<PanelState>;
      configure(preferences: Preferences): Promise<PanelState>;
      dock(): Promise<PanelState>;
      chooseImage(provider: ProviderId): Promise<string | null>;
      quit(): Promise<void>;
      onState(callback: (state: PanelState) => void): () => void;
    };
  }
}
