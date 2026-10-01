export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'deepseek';
export type Preferences = { side: 'left' | 'right'; locked: boolean; animate: boolean };
export type PanelState = Preferences & {
  collapsed: boolean; desktop: boolean; platform: string; scaleFactor: number;
  bounds?: { x: number; y: number; width: number; height: number };
};
export type Quota = { model: string; period: string; remaining: number | null; reset: string; stale?: boolean };
export type LocalProviderStatus = {
  id: 'codex' | 'antigravity'; source: 'local-api' | 'cache' | 'unavailable';
  connection: 'ready' | 'offline' | 'unavailable' | 'error';
  activity: 'running' | 'idle' | 'unknown' | 'offline'; activeTasks: number;
  task: string; quotas: Quota[]; observedAt: string | null; sampledAt: string | null; detail: string;
};
export type LocalStatus = { sampledAt: string | null; codex: LocalProviderStatus; antigravity: LocalProviderStatus; isTestData?: boolean };
export type Provider = {
  id: ProviderId; name: string; subtitle: string; color: string; running: boolean;
  task: string; quotas: Quota[]; image: string; local?: LocalProviderStatus;
};
declare global {
  interface Window {
    panel?: {
      getState(): Promise<PanelState>;
      getStatus(): Promise<LocalStatus>;
      refreshStatus(): Promise<LocalStatus>;
      onStatus(callback: (status: LocalStatus) => void): () => void;
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
