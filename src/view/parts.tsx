import { createContext, useContext, useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { animeImages } from '../data';
import { useI18n } from '../i18n';
import type { Provider, Skin } from '../types';
import { creditNumber, faceFocus, LOW, money, type ProviderView, type QuotaRow } from './model';

export type Crop = 'face' | 'bust' | 'logo';
/** Asks macOS for the accessibility grant that Claude Desktop activity needs. */
export const GrantAccessContext = createContext<(() => void) | null>(null);
/** Codex (龙娘) and Claude prompts glow red; other waiting providers keep their own breathing color. */
export const RED_ALERT = new Set(['codex', 'claude']);
export function glowOf(view: ProviderView) { return view.attention ? RED_ALERT.has(view.id) ? 'attention' : 'running' : view.state === 'running' ? 'running' : 'off'; }
const ZOOM = 1.45;

/** Square portrait or logo. Built-in anime art is cropped around the face so small frames show a face, not a fringe. */
export function Portrait({ provider, image, anime, crop = 'face', glow }: { provider: Provider; image?: string; anime: boolean; crop?: Crop; glow?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image, anime]);
  const src = image || (anime ? `./anime/${animeImages[provider.id]}` : `./${provider.image}`);
  const mode: Crop = anime ? crop : 'logo';
  let style: CSSProperties | undefined;
  if (mode === 'face') {
    const focus = image ? .42 : faceFocus[provider.id];
    const top = Math.max(-(ZOOM - 1) * 100, Math.min(0, 45 - focus * ZOOM * 100));
    style = { width: `${ZOOM * 100}%`, height: `${ZOOM * 100}%`, left: `${-(ZOOM - 1) * 50}%`, top: `${top}%` };
  }
  return <div className="avatar" data-provider={provider.id} data-glow={glow} data-anime={anime} data-crop={mode} data-default-image={!image && !anime}>
    {/* Antigravity keeps its slowly turning spectrum ring instead of a single-color halo. */}
    {provider.id === 'antigravity' && glow && glow !== 'off' && <span className="avatar-halo" aria-hidden="true"><span /></span>}
    <div className="avatar-face">
      {failed ? <span className="avatar-fallback">{provider.name.slice(0, 1)}</span>
        : <img src={src} style={style} alt={t('{p0} 助手图片', { p0: provider.name })} draggable={false} onError={() => setFailed(true)} />}
    </div>
  </div>;
}

export function LaunchAvatar({ view, image, anime, crop, busy, onOpen, children, mirror }: {
  view: ProviderView; image?: string; anime: boolean; crop?: Crop; busy?: boolean; onOpen: () => void; children?: ReactNode;
  /** A pointer-only duplicate (e.g. the attention banner) that stays out of the tab order and accessibility tree. */
  mirror?: boolean;
}) {
  const { t } = useI18n();
  return <button type="button" className="avatar-launch" aria-label={mirror ? undefined : t('打开 {p0}', { p0: view.name })} aria-hidden={mirror || undefined} tabIndex={mirror ? -1 : undefined}
    title={t('打开 {p0}', { p0: view.name })} disabled={busy} onClick={onOpen}>
    <Portrait provider={view.provider} image={image} anime={anime} crop={crop} glow={glowOf(view)} />
    {children}
  </button>;
}

export function StatePill({ view }: { view: ProviderView }) {
  return <span className="task-status state-pill" data-state={view.state}><span className={`status-dot ${dotClass(view)}`} aria-hidden="true" />{view.stateLabel}</span>;
}
export function dotClass(view: ProviderView) {
  return view.state === 'running' ? 'active' : view.state === 'waiting' ? 'waiting' : view.state === 'unknown' ? 'unknown' : '';
}

export function PlanBadge({ view }: { view: ProviderView }) {
  const { t } = useI18n();
  if (!view.plan.show) return null;
  return <span className={`plan-summary ${view.plan.stale ? 'is-stale' : ''}`} aria-label={t('{p0} 套餐档位', { p0: view.name })} title={view.plan.title}>
    <bdi className="plan-name">{view.plan.label}</bdi>{view.plan.state && <span className="plan-status">{view.plan.state}</span>}
  </span>;
}

function Value({ row }: { row: QuotaRow }) {
  const { percent } = useI18n();
  return <bdi dir="ltr" className="quota-value">{row.remaining === null ? '—' : percent(row.remaining)}</bdi>;
}
export function QuotaMeter({ row, view }: { row: QuotaRow; view: ProviderView }) {
  const { t, percent } = useI18n();
  return <div className={`quota ${row.known ? '' : 'quota-unknown'} ${row.historical ? 'quota-historical' : ''} ${row.low ? 'is-low' : ''}`} title={row.title}>
    <div className="quota-label"><span className="model-name"><bdi>{row.label}</bdi>{row.period && <small>{row.period}</small>}</span>
      <strong><span className="remaining-label">{row.status}</span><Value row={row} /></strong></div>
    <div className="quota-track" role="progressbar" aria-label={t('{p0} {p1} 剩余额度', { p0: row.label, p1: row.period })} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={row.known ? row.remaining! : undefined}
      aria-valuetext={row.historical ? t('历史剩余 {p0}%，当前额度待更新', { p0: row.remaining }) : row.known ? percent(row.remaining!) : row.stale ? t('记录已过时') : t('未知')}>
      {row.known && <div className={`quota-fill ${row.low ? 'is-low' : ''}`} style={{ width: `${row.remaining}%` }} />}
    </div>
  </div>;
}
export function QuotaRing({ row, size = 46 }: { row: QuotaRow; size?: number }) {
  const { t, percent } = useI18n();
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  return <div className={`quota quota-ring ${row.known ? '' : 'quota-unknown'} ${row.low ? 'is-low' : ''}`} title={row.title}>
    <div className="ring" role="progressbar" aria-label={t('{p0} {p1} 剩余额度', { p0: row.label, p1: row.period })} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={row.known ? row.remaining! : undefined} aria-valuetext={row.known ? percent(row.remaining!) : t('未知')} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true"><circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
        {row.known && <circle className="ring-fill" cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${(c * row.remaining! / 100).toFixed(2)} ${c.toFixed(2)}`} />}</svg>
      <span className="ring-value">{row.remaining === null ? '—' : <bdi dir="ltr">{Math.round(row.remaining)}</bdi>}</span>
    </div>
    <div className="ring-label"><bdi className="model-name">{row.label}</bdi><small>{row.period || row.status}</small></div>
  </div>;
}

export function Balance({ view }: { view: ProviderView }) {
  const { t, number } = useI18n();
  const [page, setPage] = useState(0);
  if (view.metrics.kind !== 'balance') return null;
  const { wallets, stale, empty, detail } = view.metrics;
  const wallet = wallets[Math.min(page, Math.max(0, wallets.length - 1))];
  if (!wallet) return <div className="balance-content balance-empty"><strong>{empty}</strong><p>{detail}</p></div>;
  const fmt = (value: string) => number(money(value), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <div className="balance-content" aria-label={t('DeepSeek 账户余额')}>
    <div className={`balance-total ${stale ? 'is-stale' : ''}`} dir="ltr" title={`${wallet.currency} ${wallet.total}`}>
      <small>{wallet.currency === 'CNY' ? '¥' : '$'}</small><strong>{fmt(wallet.total)}</strong><span>{wallet.currency}</span>
    </div>
    <div className="balance-parts"><span>{stale ? t('历史余额 · 待更新') : t('账户可用余额')}</span>
      <span>{t('现金')} <b>{fmt(wallet.paid)}</b> · {t('赠送')} <b>{fmt(wallet.bonus)}</b></span>
      {wallets.length > 1 && <button className="currency-switch" onClick={() => setPage((page + 1) % wallets.length)} aria-label={t('切换余额币种')}>{wallet.currency} ↔</button>}
    </div>
  </div>;
}

export function Credits({ view, limit = 99 }: { view: ProviderView; limit?: number }) {
  const { t, number, language, date } = useI18n();
  if (view.metrics.kind !== 'credits') return null;
  const { items, stale, empty, detail } = view.metrics;
  if (!items.length) return <div className="credits-list credits-empty"><strong>{empty}</strong><p title={detail}>{detail}</p></div>;
  return <div className="credits-list" aria-label={t('{p0} 剩余积分', { p0: view.name })}>
    {items.slice(0, limit).map((item, index) => <div className={`credit-item ${stale ? 'is-stale' : ''}`} key={`${item.label}:${index}`}
      title={[item.label, item.remaining === null ? t('剩余未知') : t('剩余 {p0} {p1}', { p0: item.remaining, p1: item.unit }), item.total != null ? t('总量 {p0} {p1}', { p0: item.total, p1: item.unit }) : '', item.reset ? t('重置 / 到期时间 {p0}', { p0: date(item.reset) }) : '', stale ? t('历史快照，当前值待更新') : ''].filter(Boolean).join(' · ')}>
      <strong className="credit-value"><bdi dir="ltr">{item.remaining === null ? '—' : number(creditNumber(item.remaining), { maximumFractionDigits: 2, useGrouping: language !== 'zh-CN' })}</bdi></strong>
      <span className="credit-label credit-amount">{item.label}<small>{stale ? t('历史') : item.remaining === null ? t('未知') : item.unit}</small></span>
    </div>)}
    {items.length > limit && <span className="more-quotas" title={items.slice(limit).map(item => `${item.label} · ${item.remaining === null ? t('剩余未知') : t('剩余 {p0} {p1}', { p0: item.remaining, p1: item.unit })}`).join('\n')}>{t('另有 {p0} 项', { p0: number(items.length - limit) })}</span>}
  </div>;
}

export function EmptyMetric({ view }: { view: ProviderView }) {
  if (view.metrics.kind !== 'empty') return null;
  return <div className="claude-empty"><strong>{view.metrics.title}</strong><p>{view.metrics.detail}</p></div>;
}

/** The figure each skin shows when a card has no percentage: balance, first credit, or nothing. */
export function headline(view: ProviderView, number: (value: string | number, options?: Intl.NumberFormatOptions) => string) {
  if (view.metrics.kind === 'balance' && view.metrics.wallets[0]) return (view.metrics.wallets[0].currency === 'CNY' ? '¥' : '$') + money(view.metrics.wallets[0].total);
  if (view.metrics.kind === 'credits' && view.metrics.items[0]?.remaining) return number(creditNumber(view.metrics.items[0].remaining), { maximumFractionDigits: 1, useGrouping: false });
  return view.tightest === null ? '—' : `${Math.round(view.tightest)}%`;
}

export function TaskLine({ view, children }: { view: ProviderView; children?: ReactNode }) {
  const { t } = useI18n();
  const grant = useContext(GrantAccessContext);
  return <div className="task-line" title={view.taskTitle} data-inferred={view.inferred || undefined}><span className={`status-dot ${dotClass(view)}`} aria-hidden="true" /><span className="task-text">{view.task}</span>
    {view.accessRequired && grant ? <button type="button" className="grant-access" onClick={grant}>{t('授权辅助功能')}</button> : children}</div>;
}

export function SourceTag({ view }: { view: ProviderView }) {
  return <span className={`source-tag ${view.isLocal ? 'local' : ''}`} title={view.sourceTitle}>{view.source}</span>;
}

export function CardShell({ view, skin, index, sortProps, dragging, animationPaused, children }: {
  view: ProviderView; skin: Skin; index: number; sortProps?: HTMLAttributes<HTMLElement>; dragging: boolean; animationPaused: boolean; children: ReactNode;
}) {
  const { t, number } = useI18n();
  return <section {...sortProps} className={`provider-card card-${skin} ${view.state === 'running' ? 'is-running' : ''} ${dragging ? 'is-dragging' : ''}`}
    style={{ '--accent': view.color, ...sortProps?.style } as CSSProperties} data-provider={view.id} data-state={view.state} data-attention={view.attention}
    data-animation-paused={animationPaused} aria-label={t('{p0} 面板', { p0: view.name })} tabIndex={0} aria-describedby="card-sort-help" onDragStart={event => event.preventDefault()}>
    <span className="card-index" title={t('长按卡片拖动排序')}><GripVertical size={10} aria-hidden="true" /><bdi dir="ltr">{number(index + 1, { minimumIntegerDigits: 2 })}</bdi></span>
    {children}
  </section>;
}

export function isLow(value: number | null) { return value !== null && value < LOW; }
