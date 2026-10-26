import { useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { Skin } from '../types';
import type { ProviderView } from './model';
import { Balance, CardShell, Credits, EmptyMetric, LaunchAvatar, PlanBadge, QuotaMeter, QuotaRing, SourceTag, StatePill, TaskLine, dotClass, headline, isLow } from './parts';

export type CardProps = {
  view: ProviderView; skin: Skin; index: number; anime: boolean; image?: string; busy: boolean; onOpen: () => void;
  sortProps?: HTMLAttributes<HTMLElement>; dragging: boolean; animationPaused: boolean; fullscreen: boolean; details?: ReactNode;
  /** The screen has no pointer: preserve the card, but replace controls with automatic pages. */
  readOnly?: boolean; cycleSeconds?: number;
};

function Metrics({ view, layout, limit = 99, readOnly = false, cycleSeconds = 4, animationPaused = false }: {
  view: ProviderView; layout: 'grid' | 'rows' | 'rings'; limit?: number; readOnly?: boolean; cycleSeconds?: number; animationPaused?: boolean;
}) {
  const { t, number } = useI18n();
  const [page, setPage] = useState(0);
  const metrics = view.metrics;
  const length = metrics.kind === 'quota' ? metrics.rows.length : metrics.kind === 'credits' ? metrics.items.length : metrics.kind === 'balance' ? metrics.wallets.length : 0;
  const pageSize = metrics.kind === 'balance' ? 1 : 2;
  const pages = Math.max(1, Math.ceil(length / pageSize));
  // Keep this clock separate from motion preferences: these are data pages, not effects.
  // Off-screen cards retain their page and resume when the module rotation brings them back.
  useEffect(() => {
    if (!readOnly || animationPaused || pages < 2) return;
    const timer = window.setInterval(() => setPage(current => (current + 1) % pages), Math.max(3, cycleSeconds) * 1000);
    return () => clearInterval(timer);
  }, [readOnly, animationPaused, cycleSeconds, pages]);
  const currentPage = page % pages;
  if (readOnly) {
    const start = currentPage * pageSize;
    let content: ReactNode;
    if (metrics.kind === 'balance') content = <Balance view={{ ...view, metrics: { ...metrics, wallets: metrics.wallets.slice(start, start + 1) } }} readOnly />;
    else if (metrics.kind === 'credits') content = <Credits view={{ ...view, metrics: { ...metrics, items: metrics.items.slice(start, start + pageSize) } }} />;
    else if (metrics.kind === 'empty') content = <EmptyMetric view={view} />;
    else content = <div className={`quota-list quota-${layout}`}>
      {metrics.rows.slice(start, start + pageSize).map(row => layout === 'rings' ? <QuotaRing key={row.key} row={row} /> : <QuotaMeter key={row.key} row={row} view={view} />)}
    </div>;
    return <div className="screen-metrics" data-metric-page={currentPage + 1} data-metric-pages={pages}>
      {content}
      {pages > 1 && <span className="screen-metric-page">{number(currentPage + 1)} / {number(pages)}</span>}
    </div>;
  }
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
      <LaunchAvatar view={view} image={props.image} anime={anime} busy={props.busy} onOpen={props.onOpen} readOnly={props.readOnly}><span className={`avatar-dot status-dot ${dotClass(view)}`} aria-hidden="true" /></LaunchAvatar>
      <div className="identity"><h2><bdi>{view.name}</bdi></h2><div className="identity-meta"><span className="eyebrow">{view.eyebrow}</span><PlanBadge view={view} /></div></div>
      <StatePill view={view} />
    </div>
    <div className="quota-area"><Metrics {...props} layout="grid" /></div>
    <TaskLine view={view} readOnly={props.readOnly}><SourceTag view={view} /></TaskLine>
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
        <LaunchAvatar view={view} image={props.image} anime busy={props.busy} onOpen={props.onOpen} readOnly={props.readOnly} />
        <span className="dial-figure"><bdi dir="ltr">{headline(view, number)}</bdi></span>
      </div>
      <div className="dial-body">
        <div className="card-heading"><div className="identity"><h2><bdi>{view.name}</bdi></h2><PlanBadge view={view} /></div><StatePill view={view} /></div>
        <TaskLine view={view} readOnly={props.readOnly} />
        <div className="quota-area"><Metrics {...props} layout="rows" limit={3} /></div>
      </div>
    </div> : <>
      <div className="card-heading">
        <LaunchAvatar view={view} image={props.image} anime={false} busy={props.busy} onOpen={props.onOpen} readOnly={props.readOnly} />
        <div className="identity"><h2><bdi>{view.name}</bdi><PlanBadge view={view} /></h2><TaskLine view={view} readOnly={props.readOnly} /></div>
        <StatePill view={view} />
      </div>
      <div className="quota-area"><Metrics {...props} layout="rings" limit={3} /></div>
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
      <LaunchAvatar view={view} image={props.image} anime={anime} crop={props.readOnly ? 'face' : 'bust'} busy={props.busy} onOpen={props.onOpen} readOnly={props.readOnly} />
      <span className="party-badge"><StatePill view={view} /></span>
      <div className="card-heading"><div className="identity"><h2><bdi>{view.name}</bdi></h2><PlanBadge view={view} /></div></div>
    </div>
    <div className="quota-area"><Metrics {...props} layout="rows" limit={3} /></div>
    <TaskLine view={view} readOnly={props.readOnly}><SourceTag view={view} /></TaskLine>
    {props.details}
  </CardShell>;
}

/** The curved display dedicates the upper half to a large identity portrait.
 * Keep the same skin components and metric animations below it, without
 * changing the desktop cards' compact arrangement. */
function ScreenCard(props: CardProps) {
  const { view, skin, anime } = props;
  const { number, t } = useI18n();
  const r = 38, c = 2 * Math.PI * r;
  const fill = view.tightest === null ? 100 : view.tightest;
  const portrait = <LaunchAvatar view={view} image={props.image} anime={anime} crop="face" onOpen={props.onOpen} readOnly />;
  return <CardShell {...props}>
    <div className="screen-card-top">
      <div className="screen-card-portrait">
        {skin === 'dial' ? <div className={`dial-frame ${isLow(view.tightest) ? 'is-low' : ''}`} title={t('外圈为最紧额度')}>
          <svg viewBox="0 0 84 84" aria-hidden="true"><circle className="ring-track" cx="42" cy="42" r={r} /><circle className={`ring-fill ${view.tightest === null ? 'is-neutral' : ''}`} cx="42" cy="42" r={r} strokeDasharray={`${(c * fill / 100).toFixed(2)} ${c.toFixed(2)}`} /></svg>
          {portrait}
          <span className="dial-figure"><bdi dir="ltr">{headline(view, number)}</bdi></span>
        </div> : portrait}
      </div>
      <div className="screen-card-identity identity">
        <h2><bdi>{view.name}</bdi></h2>
        <PlanBadge view={view} />
        <StatePill view={view} />
        <TaskLine view={view} readOnly />
      </div>
    </div>
    <div className="quota-area screen-card-bottom"><Metrics {...props} layout={skin === 'watch' ? 'grid' : 'rows'} /></div>
  </CardShell>;
}

export function ProviderCard(props: CardProps) {
  if (props.readOnly) return <ScreenCard {...props} />;
  return props.skin === 'dial' ? <DialCard {...props} /> : props.skin === 'party' ? <PartyCard {...props} /> : <WatchCard {...props} />;
}

export type Summary = { running: number; waiting: ProviderView[]; tightest: { view: ProviderView; value: number } | null; idle: number; total: number };
export function summarize(views: ProviderView[]): Summary {
  let tightest: Summary['tightest'] = null;
  for (const view of views) if (view.tightest !== null && (!tightest || view.tightest < tightest.value)) tightest = { view, value: view.tightest };
  // Count running tasks, not cards: one assistant can run several and still be waiting on you.
  const running = views.reduce((total, view) => total + (view.provider.local ? view.provider.local.activeTasks || 0 : view.state === 'running' ? 1 : 0), 0);
  const waiting = views.filter(view => view.attention);
  const busy = views.filter(view => view.state === 'running' || view.attention).length;
  return { running, waiting, tightest, idle: views.length - busy, total: views.length };
}

/** The summary under the header; each skin phrases the same three facts its own way. */
export function Overview({ skin, summary, live, stamp, badge, onOpen, image, anime, onReveal }: {
  skin: Skin; summary: Summary; live: boolean; stamp: string; badge: ReactNode; onOpen: (view: ProviderView) => void;
  image: (view: ProviderView) => string | undefined; anime: boolean; onReveal: (view: ProviderView) => void;
}) {
  const { t, number, percent } = useI18n();
  const tight = summary.tightest;
  // Every assistant waiting on you gets its own row; nothing is folded into a "+N".
  const single = summary.waiting.length === 1;
  const attention = summary.waiting.length > 0 && <div className="attention-list" data-count={summary.waiting.length} aria-live="polite" aria-label={t('等你处理')}>
    {summary.waiting.map(view => <div className="attention" role="group" aria-label={view.name} key={view.id} data-provider={view.id} style={{ '--accent': view.color } as CSSProperties}>
      <LaunchAvatar view={view} image={image(view)} anime={anime} crop={skin === 'watch' && anime && single ? 'bust' : 'face'} onOpen={() => onOpen(view)} mirror />
      <button type="button" className="attention-text" onClick={() => onReveal(view)}>
        <span className="attention-kicker">{view.stateLabel}</span>
        <strong>{t('{p0} 在等你', { p0: view.name })}</strong>
        <span className="attention-task">{view.task}</span>
      </button>
      <button type="button" className="attention-open" onClick={() => onOpen(view)}>{t('打开')}</button>
    </div>)}
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
      <div className="stat" data-kind="running"><span>{t('运行中')}</span><strong key={summary.running}><bdi dir="ltr">{number(summary.running)}</bdi></strong></div>
      <div className="stat" data-kind="waiting" data-active={summary.waiting.length > 0}><span>{t('等你处理')}</span><strong key={summary.waiting.length}><bdi dir="ltr">{number(summary.waiting.length)}</bdi></strong></div>
      <div className="stat" data-kind="tight" data-low={isLow(tight?.value ?? null)} title={tight ? `${tight.view.name} · ${percent(tight.value)}` : ''}><span>{t('最紧额度')}</span><strong key={tight ? Math.round(tight.value) : 'none'}><bdi dir="ltr">{tight ? percent(tight.value) : '—'}</bdi></strong><small>{tight?.view.name}</small></div>
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
