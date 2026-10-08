import type { Language } from './i18n';
export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'deepseek' | 'zcode' | 'kimi' | 'qwen' | 'workbuddy';
export type Theme = 'system' | 'light' | 'dark';
export type Layout = 'single' | 'double' | 'fullscreen';
export type TaskDetail = { title: string | null; state: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'idle'; updatedAt: string | null; stale: boolean; source: 'cache' | 'local-api'; operation: string | null; steps: number | null; toolCalls: number | null; progress: number | null };
export type KimiSource = 'code' | 'work';
export type ClaudeSource = 'desktop' | 'code';
export type Preferences = { side: 'left' | 'right'; locked: boolean; animate: boolean };
export type PanelState = Preferences & {
  collapsed: boolean; desktop: boolean; platform: string; scaleFactor: number;
  trayAvailable: boolean; stored: boolean;
  providerOrder: ProviderId[];
  enabledProviders: ProviderId[];
  qwenKeychainAllowed: boolean;
  kimiSource: KimiSource;
  claudeSource: ClaudeSource;
  claudeNetworkAllowed: boolean;
  animeMode: boolean; layout: Layout; windowLayout: 'single' | 'double';
  language: Language; resolvedLanguage?: Exclude<Language, 'system'>;
  theme: Theme; resolvedTheme: 'light' | 'dark';
  bounds?: { x: number; y: number; width: number; height: number };
};
export type Quota = { model: string; period: string; remaining: number | null; reset: string; stale?: boolean; resetKind?: 'expiry'; variants?: string[] };
export type Wallet = { currency: 'CNY' | 'USD'; total: string; paid: string; bonus: string };
export type CreditItem = { label: string; remaining: string | null; total?: string | null; unit: string; reset?: string };
export type LocalProviderStatus = {
  id: ProviderId; source: 'local-api' | 'account' | 'cache' | 'unavailable';
  connection: 'ready' | 'offline' | 'unavailable' | 'error' | 'auth-required';
  activity: 'running' | 'waiting' | 'idle' | 'unknown' | 'offline'; activeTasks: number;
  task: string; quotas: Quota[]; observedAt: string | null; sampledAt: string | null; detail: string;
  waitingTasks?: number; waitingReason?: 'input' | 'approval' | 'both'; attentionAvailable?: boolean;
  accessRequired?: boolean;
  activityAccessRequired?: boolean;
  activityAccessState?: 'granted' | 'denied' | 'unknown' | 'unsupported';
  activityProbeError?: 'invalid-pid' | 'unsupported-platform' | 'helper-missing' | 'helper-blocked' | 'timeout' | 'helper-failed' | 'invalid-output' | 'permission-check-failed' | 'helper-access-denied';
  kimiSource?: KimiSource;
  claudeSource?: ClaudeSource;
  activityDetail?: string; activityObservedAt?: string | null;
  taskDetails?: TaskDetail[];
  surfaces?: { desktop: string; terminal: string };
  balance?: { wallets: Wallet[]; stale: boolean };
  plan?: { name: string | null; status?: string; expiresAt?: string | null; stale?: boolean };
  credits?: { items: CreditItem[]; stale: boolean };
};
export type LocalStatus = Record<ProviderId, LocalProviderStatus> & { sampledAt: string | null; isTestData?: boolean };
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
      store(): Promise<PanelState>;
      configure(preferences: Preferences): Promise<PanelState>;
      setOrder(order: ProviderId[]): Promise<PanelState>;
      setEnabled(ids: ProviderId[]): Promise<PanelState>;
      setQwenAccess(allowed: boolean): Promise<PanelState>;
      setKimiSource(source: KimiSource): Promise<PanelState>;
      setClaudeSource(source: ClaudeSource): Promise<PanelState>;
      setClaudeNetworkAccess(allowed: boolean): Promise<PanelState>;
      requestClaudeActivityAccess(): Promise<LocalStatus>;
      clearCache(): Promise<{ freedBytes: number }>;
      setAnimeMode(enabled: boolean): Promise<PanelState>;
      openProvider(provider: ProviderId): Promise<{ status: 'opened' | 'missing' | 'unsupported' | 'error' | 'test'; message: string }>;
      chooseProviderApp(provider: ProviderId): Promise<{ status: 'selected' | 'cancelled' | 'error'; message: string }>;
      setLanguage(language: Language): Promise<PanelState>;
      setLayout(layout: Layout): Promise<PanelState>;
      setTheme(theme: Theme): Promise<PanelState>;
      dock(): Promise<PanelState>;
      chooseImage(provider: ProviderId): Promise<string | null>;
      quit(): Promise<void>;
      onState(callback: (state: PanelState) => void): () => void;
    };
  }
}
