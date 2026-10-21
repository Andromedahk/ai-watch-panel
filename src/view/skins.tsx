import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { Skin } from '../types';
import type { ProviderView } from './model';
import { Balance, CardShell, Credits, EmptyMetric, LaunchAvatar, PlanBadge, QuotaMeter, QuotaRing, SourceTag, StatePill, TaskLine, dotClass, headline, isLow } from './parts';

export type CardProps = {
  view: ProviderView; skin: Skin; index: number; anime: boolean; image?: string; busy: boolean; onOpen: () => void;
  sortProps?: HTMLAttributes<HTMLElement>; dragging: boolean; animationPaused: boolean; fullscreen: boolean; details?: ReactNode;
};

function Metrics({ view, layout, limit = 99 }: { view: ProviderView; layout: 'grid' | 'rows' | 'rings'; limit?: number }) {
  const { t, number } = useI18n();
  if (view.metrics.kind === 'balance') return <Balance view={view} />;
  if (view.metrics.kind === 'credits') return <Credits view={view} limit={Math.min(limit, 2)} />;
  if (view.metrics.kind === 'empty') return <EmptyMetric view={view} />;
  const rows = view.metrics.rows, shown = rows.slice(0, limit), rest = rows.slice(limit);
  const more = rest.length > 0 && <span className="more-quotas" title={rest.map(row => row.title).join('\n')}>{t('另有 {p0} 项', { p0: number(rest.length) })}</span>;
  if (layout === 'rings') return <div className="quota-list quota-rings">{shown.map(row => <QuotaRing key={row.key} row={row} />)}{more}</div>;
  return <div className={`quota-list quota-${layout}`}>{shown.map(row => <QuotaMeter key={row.key} row={row} view={view} />)}{more}</div>;
}

/** A · 值守台: compact row, everything readable at a glance. */
function WatchCard(props: CardProps) {
  const { view, anime } = props;
  return <CardShell {...props}>
    <div className="card-heading">
      <LaunchAvatar view={view} image={props.image} anime={anime} busy={props.busy} onOpen={props.onOpen}><span className={`avatar-dot status-dot ${dotClass(view)}`} aria-hidden="true" /></LaunchAvatar>
      <div className="identity"><h2><bdi>{view.name}</bdi></h2><div className="identity-meta"><span className="eyebrow">{view.eyebrow}</span><PlanBadge view={view} /></div></div>
      <StatePill view={view} />
    </div>
    <div className="quota-area"><Metrics view={view} layout="grid" /></div>
    <TaskLine view={view}><SourceTag view={view} /></TaskLine>
    {props.details}
  </CardShell>;
}

/** B · 表盘: calm card; quotas as rings, or the portrait framed by its tightest quota in anime mode. */
function DialCard(props: CardProps) {
  const { view, anime } = props;
  const { number, t } = useI18n();
  const r = 38, c = 2 * Math.PI * r;
  const fill = view.tightest === null ? 100 : view.tightest;
  return <CardShell {...props}>
    {anime ? <div className="dial-hero">
      <div className={`dial-frame ${isLow(view.tightest) ? 'is-low' : ''}`} title={t('外圈为最紧额度')}>
        <svg viewBox="0 0 84 84" aria-hidden="true"><circle className="ring-track" cx="42" cy="42" r={r} /><circle className={`ring-fill ${view.tightest === null ? 'is-neutral' : ''}`} cx="42" cy="42" r={r} strokeDasharray={`${(c * fill / 100).toFixed(2)} ${c.toFixed(2)}`} /></svg>
        <LaunchAvatar view={view} image={props.image} anime busy={props.busy} onOpen={props.onOpen} />
        <span className="dial-figure"><bdi dir="ltr">{headline(view, number)}</bdi></span>
      </div>
      <div className="dial-body">
        <div className="card-heading"><div className="identity"><h2><bdi>{view.name}</bdi></h2><PlanBadge view={view} /></div><StatePill view={view} /></div>
        <TaskLine view={view} />
        <div className="quota-area"><Metrics view={view} layout="rows" limit={3} /></div>
      </div>
    </div> : <>
      <div className="card-heading">
        <LaunchAvatar view={view} image={props.image} anime={false} busy={props.busy} onOpen={props.onOpen} />
        <div className="identity"><h2><bdi>{view.name}</bdi><PlanBadge view={view} /></h2><TaskLine view={view} /></div>
        <StatePill view={view} />
      </div>
      <div className="quota-area"><Metrics view={view} layout="rings" limit={3} /></div>
    </>}
    <div className="card-foot"><SourceTag view={view} />{view.observed && <span className="quota-time">{t('记录 {p0}', { p0: view.observed })}</span>}</div>
    {props.details}
  </CardShell>;
}

/** C · 角色栏: a party roster — the character (or a large emblem) is the card. */
function PartyCard(props: CardProps) {
  const { view, anime } = props;
  return <CardShell {...props}>
    <div className="party-stage">
      <LaunchAvatar view={view} image={props.image} anime={anime} crop="bust" busy={props.busy} onOpen={props.onOpen} />
      <span className="party-badge"><StatePill view={view} /></span>
      <div className="card-heading"><div className="identity"><h2><bdi>{view.name}</bdi></h2><PlanBadge view={view} /></div></div>
    </div>
    <div className="quota-area"><Metrics view={view} layout="rows" limit={3} /></div>
    <TaskLine view={view}><SourceTag view={view} /></TaskLine>
    {props.details}
  </CardShell>;
}

export function ProviderCard(props: CardProps) {
  return props.skin === 'dial' ? <DialCard {...props} /> : props.skin === 'party' ? <PartyCard {...props} /> : <WatchCard {...props} />;
}

export type Summary = { running: number; waiting: ProviderView[]; tightest: { view: ProviderView; value: number } | null; idle: number; total: number };
export function summarize(views: ProviderView[]): Summary {
  let tightest: Summary['tightest'] = null;
  for (const view of views) if (view.tightest !== null && (!tightest || view.tightest < tightest.value)) tightest = { view, value: view.tightest };
  const running = views.filter(view => view.state === 'running').length;
  const waiting = views.filter(view => view.attention);
  return { running, waiting, tightest, idle: views.length - running - waiting.length, total: views.length };
}

/** The summary under the header; each skin phrases the same three facts its own way. */
export function Overview({ skin, summary, live, stamp, badge, onOpen, image, anime, onReveal }: {
  skin: Skin; summary: Summary; live: boolean; stamp: string; badge: ReactNode; onOpen: (view: ProviderView) => void;
  image: (view: ProviderView) => string | undefined; anime: boolean; onReveal: (view: ProviderView) => void;
}) {
  const { t, number, percent } = useI18n();
  const first = summary.waiting[0];
  const tight = summary.tightest;
  const attention = first && <div className="attention" role="status">
    <LaunchAvatar view={first} image={image(first)} anime={anime} crop={skin === 'watch' && anime ? 'bust' : 'face'} onOpen={() => onOpen(first)} />
    <button type="button" className="attention-text" onClick={() => onReveal(first)}>
      <span className="attention-kicker">{first.stateLabel}{summary.waiting.length > 1 ? ` · +${number(summary.waiting.length - 1)}` : ''}</span>
      <strong>{t('{p0} 在等你', { p0: first.name })}</strong>
      <span className="attention-task">{first.task}</span>
    </button>
    <button type="button" className="attention-open" onClick={() => onOpen(first)}>{t('打开')}</button>
  </div>;
  if (skin === 'dial') return <section className="overview overview-dial" aria-label={t('总览')}>
    <p className="overview-headline">{summary.waiting.length ? t('{p0} 个在跑，{p1} 个等你', { p0: summary.running, p1: summary.waiting.length }) : t('{p0} 个在跑', { p0: summary.running })}</p>
    <p className="overview-meta">{badge}{stamp && <span><time dir="ltr">{stamp}</time></span>}{tight && <span>{t('最紧 {p0} · {p1}', { p0: tight.view.name, p1: percent(tight.value) })}</span>}</p>
    {attention}
  </section>;
  if (skin === 'party') return <section className="overview overview-party" aria-label={t('总览')}>
    <div className="party-chips">
      <span data-kind="running"><i />{t('出战 {p0}', { p0: summary.running })}</span>
      <span data-kind="waiting" data-active={summary.waiting.length > 0}><i />{t('呼叫你 {p0}', { p0: summary.waiting.length })}</span>
      <span data-kind="idle"><i />{t('休息 {p0}', { p0: summary.idle })}</span>
    </div>
    <p className="overview-meta">{badge}{stamp && <span><time dir="ltr">{stamp}</time></span>}</p>
    {attention}
  </section>;
  return <section className="overview overview-watch" aria-label={t('总览')}>
    <div className="stat-tiles">
      <div className="stat" data-kind="running"><span>{t('运行中')}</span><strong><bdi dir="ltr">{number(summary.running)}</bdi></strong></div>
      <div className="stat" data-kind="waiting" data-active={summary.waiting.length > 0}><span>{t('等你处理')}</span><strong><bdi dir="ltr">{number(summary.waiting.length)}</bdi></strong></div>
      <div className="stat" data-kind="tight" data-low={isLow(tight?.value ?? null)} title={tight ? `${tight.view.name} · ${percent(tight.value)}` : ''}><span>{t('最紧额度')}</span><strong><bdi dir="ltr">{tight ? percent(tight.value) : '—'}</bdi></strong><small>{tight?.view.name}</small></div>
    </div>
    {attention}
    <p className="overview-meta">{badge}{stamp && <span><time dir="ltr">{stamp}</time></span>}</p>
  </section>;
}

export function RailItem({ view, skin, anime, image, busy, onOpen }: { view: ProviderView; skin: Skin; anime: boolean; image?: string; busy: boolean; onOpen: () => void }) {
  const { t, number } = useI18n();
  const r = 23, c = 2 * Math.PI * r, fill = view.tightest === null ? 100 : view.tightest;
  return <div className="rail-item" data-provider={view.id} data-state={view.state} title={`${view.name} · ${view.stateLabel} · ${view.task}`} style={{ '--accent': view.color } as CSSProperties}>
    {skin === 'dial' && <svg className={`rail-ring ${isLow(view.tightest) ? 'is-low' : ''}`} viewBox="0 0 52 52" aria-hidden="true"><circle className="ring-track" cx="26" cy="26" r={r} /><circle className={`ring-fill ${view.tightest === null ? 'is-neutral' : ''}`} cx="26" cy="26" r={r} strokeDasharray={`${(c * fill / 100).toFixed(2)} ${c.toFixed(2)}`} /></svg>}
    <LaunchAvatar view={view} image={image} anime={anime} busy={busy} onOpen={onOpen} />
    <span className={`status-dot ${dotClass(view)}`} aria-hidden="true" />
    {skin !== 'dial' && <span className={`rail-bar ${isLow(view.tightest) ? 'is-low' : ''} ${view.tightest === null ? 'is-neutral' : ''}`} aria-label={view.tightest === null ? undefined : t('最紧额度 {p0}', { p0: number(Math.round(view.tightest)) + '%' })}><span style={{ width: `${fill}%` }} /></span>}
  </div>;
}
