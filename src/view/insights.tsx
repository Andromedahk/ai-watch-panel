// Lower-half panels keep their full contents in a separate vertical scroller.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { DAY, type Journal, type JournalEvent } from '../journal';
import type { InsightId, Insights, ProviderId } from '../types';
import { LOW, type ProviderView } from './model';
import { Portrait } from './parts';
import quipBook from './quips.json';

const MARGIN = 12;
/** Top-to-bottom order; the mascot stands at the bottom edge. */
const ORDER: InsightId[] = ['resets', 'trend', 'timeline', 'mascot'];
const WIDE = 600;

/** Use spare height when available; otherwise reserve a scrollable area while keeping the card list accessible. */
export function useInsightSpace(stage: RefObject<HTMLDivElement | null>, viewport: RefObject<HTMLDivElement | null>, key: string, paused: boolean) {
  const [space, setSpace] = useState({ height: 0, width: 0 });
  useLayoutEffect(() => {
    const root = stage.current, list = viewport.current;
    if (!root || !list) { setSpace({ height: 0, width: 0 }); return; }
    const measure = () => {
      if (paused) return;
      const box = list.getBoundingClientRect(), style = getComputedStyle(list);
      let bottom = box.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
      for (const child of list.children) if (child instanceof HTMLElement && child.offsetParent !== null) bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
      const content = bottom - box.top + list.scrollTop + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
      const used = content + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      const spare = Math.floor(root.clientHeight - used - MARGIN);
      const height = Math.max(Math.min(180, Math.floor(root.clientHeight * .4)), spare);
      setSpace(current => Math.abs(current.height - height) < 1 && current.width === root.clientWidth ? current : { height, width: root.clientWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const child of list.children) observer.observe(child);
    return () => observer.disconnect();
  }, [stage, viewport, key, paused]);
  return space;
}

function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

function Face({ view, anime, image }: { view: ProviderView; anime: boolean; image?: string }) {
  return <span className="insight-face" style={{ '--accent': view.color } as CSSProperties}><Portrait provider={view.provider} image={image} anime={anime} /></span>;
}

function eventLabel(event: JournalEvent, t: ReturnType<typeof useI18n>['t']) {
  if (event.to === 'running') return event.from === 'waiting' ? t('继续运行') : t('开始运行');
  if (event.to === 'waiting') return event.reason === 'approval' ? t('等你授权') : event.reason === 'input' ? t('等你回答') : event.reason === 'both' ? t('等你授权和回答') : t('等你处理');
  if (event.to === 'offline') return t('已退出');
  return event.from === 'running' ? t('完成任务') : event.from === 'waiting' ? t('已处理') : t('已启动');
}

function Timeline({ views, journal, anime, image }: PanelProps) {
  const { t, date } = useI18n();
  const now = useNow(60000);
  const byId = new Map(views.map(view => [view.id, view]));
  const events = journal.events.filter(event => byId.has(event.id) && now - event.at <= DAY).slice(-40).reverse();
  return <section className="insight insight-timeline" data-insight="timeline" aria-label={t('动态时间线')}>
    <header><h3>{t('动态')}</h3><small>{t('近 24 小时')}</small></header>
    {events.length ? <ol>{events.map(event => {
      const view = byId.get(event.id)!;
      return <li key={`${event.id}:${event.at}`} data-kind={event.to}>
        <time dateTime={new Date(event.at).toISOString()}>{date(new Date(event.at).toISOString(), { hour: '2-digit', minute: '2-digit' })}</time>
        <i aria-hidden="true" /><Face view={view} anime={anime} image={image(view)} />
        <span className="insight-name"><bdi>{view.name}</bdi></span><span className="insight-what">{eventLabel(event, t)}</span>
      </li>;
    })}</ol> : <p className="insight-empty">{t('暂无状态变化')}</p>}
  </section>;
}

function countdown(at: number, now: number, i18n: ReturnType<typeof useI18n>) {
  const minutes = Math.max(1, Math.round((at - now) / 60000));
  if (minutes < 60) return i18n.t('{p0} 分钟后', { p0: i18n.number(minutes) });
  if (minutes < 24 * 60) return i18n.t('{p0} 小时 {p1} 分后', { p0: i18n.number(Math.floor(minutes / 60)), p1: i18n.number(minutes % 60) });
  return i18n.date(new Date(at).toISOString(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function Resets({ views, anime, image }: PanelProps) {
  const i18n = useI18n(), { t, percent } = i18n;
  const now = useNow(30000);
  const rows = views.flatMap(view => (view.provider.local?.quotas || []).map((quota, index) => ({ view, quota, index, at: Date.parse(quota.reset) })))
    .filter(row => Number.isFinite(row.at) && row.at > now && !row.quota.stale)
    .sort((a, b) => a.at - b.at).slice(0, 8);
  return <section className="insight insight-resets" data-insight="resets" aria-label={t('额度重置日程')}>
    <header><h3>{t('额度重置')}</h3><small>{t('按恢复时间')}</small></header>
    {rows.length ? <ul>{rows.map(({ view, quota, index, at }) => <li key={`${view.id}:${index}`} data-low={quota.remaining !== null && quota.remaining < LOW}>
      <Face view={view} anime={anime} image={image(view)} />
      <span className="insight-name"><bdi>{view.name}</bdi><small><bdi>{[quota.model === view.name ? '' : quota.model, quota.period].filter(Boolean).join(' · ')}</bdi></small></span>
      <span className="insight-value">{quota.remaining === null ? '—' : percent(quota.remaining)}</span>
      <span className="insight-when" title={i18n.date(new Date(at).toISOString())}>{quota.resetKind === 'expiry' ? t('{p0} 到期', { p0: countdown(at, now, i18n) }) : countdown(at, now, i18n)}</span>
    </li>)}</ul> : <p className="insight-empty">{t('暂无即将重置的额度')}</p>}
  </section>;
}

function Trend({ views, journal, anime, image }: PanelProps) {
  const { t, percent } = useI18n();
  const now = useNow(60000);
  const rows = views.map(view => ({ view, points: (journal.samples[view.id] || []).filter(([at]) => now - at <= DAY) })).filter(row => row.points.length > 1);
  return <section className="insight insight-trend" data-insight="trend" aria-label={t('额度趋势')}>
    <header><h3>{t('额度趋势')}</h3><small>{t('近 24 小时 · 最紧额度')}</small></header>
    {rows.length ? <ul>{rows.map(({ view, points }) => {
      const line = points.map(([at, value]) => `${((at - (now - DAY)) / DAY * 100).toFixed(2)},${(23 - value / 100 * 22).toFixed(2)}`).join(' ');
      const current = points[points.length - 1][1];
      return <li key={view.id} style={{ '--accent': view.color } as CSSProperties} data-low={current < LOW}>
        <Face view={view} anime={anime} image={image(view)} /><span className="insight-name"><bdi>{view.name}</bdi></span>
        <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={line} /></svg>
        <span className="insight-value">{percent(current)}</span>
      </li>;
    })}</ul> : <p className="insight-empty">{t('记录中，稍后显示趋势')}</p>}
  </section>;
}

type Mood = 'alert' | 'busy' | 'worried' | 'rest' | 'empty' | 'chat';
/** Idle chatter per agent as [Chinese, English]; other languages show the English line. */
const quips = quipBook as Record<ProviderId, [string, string][]>;
type Quip = { id: ProviderId; index: number; status: string };

/** Hand the bubble to another shown agent, skipping lines heard recently. */
function nextQuip(views: ProviderView[], speaker: ProviderId | undefined, recent: string[]) {
  const speakers = views.filter(view => quips[view.id]?.length);
  const pool = speakers.length > 1 ? speakers.filter(view => view.id !== speaker) : speakers;
  const view = pool[Math.floor(Math.random() * pool.length)];
  if (!view) return undefined;
  const all = quips[view.id].map((_, index) => index), fresh = all.filter(index => !recent.includes(`${view.id}:${index}`));
  const choices = fresh.length ? fresh : all;
  return { id: view.id, index: choices[Math.floor(Math.random() * choices.length)] };
}

function Mascot({ views, anime, image, onOpen }: PanelProps) {
  const { t, number, percent, language } = useI18n();
  const [quip, setQuip] = useState<Quip | null>(null);
  const [spins, setSpins] = useState(0);
  const recent = useRef<string[]>([]);
  const waiting = views.find(view => view.attention), running = views.filter(view => view.state === 'running');
  const low = views.filter(view => view.tightest !== null && view.tightest < LOW).sort((a, b) => a.tightest! - b.tightest!)[0];
  let mood: Mood, focus: ProviderView | undefined, line: string;
  if (waiting) {
    mood = 'alert'; focus = waiting;
    const reason = waiting.provider.local?.waitingReason;
    line = reason === 'approval' ? t('{p0} 在等你授权哦', { p0: waiting.name }) : reason === 'input' ? t('{p0} 有问题想问你', { p0: waiting.name }) : t('{p0} 在等你处理', { p0: waiting.name });
  } else if (running.length) {
    mood = 'busy'; focus = running[0];
    line = running.length === 1 ? t('{p0} 正在努力干活', { p0: running[0].name }) : t('{p0} 位助手正在努力干活', { p0: number(running.length) });
  } else if (low) {
    mood = 'worried'; focus = low;
    line = t('{p0} 的额度只剩 {p1} 了，省着点用', { p0: low.name, p1: percent(low.tightest!) });
  } else if (views.length) {
    mood = 'rest'; focus = views[0]; line = t('大家都在休息，喝杯茶吧');
  } else { mood = 'empty'; line = t('还没有助手上线'); }
  // A refreshed line stays until the room's status changes, so alerts always win.
  const status = line, speaker = quip?.status === status ? views.find(view => view.id === quip.id) : undefined;
  // Non-Chinese languages show the English line, kept left-to-right inside RTL layouts.
  const english = !language.startsWith('zh') && Boolean(quip && speaker);
  if (quip && speaker) { mood = 'chat'; focus = speaker; line = quips[speaker.id][quip.index][english ? 1 : 0]; }
  const refresh = () => {
    const next = nextQuip(views, focus?.id, recent.current);
    if (!next) return;
    recent.current = [...recent.current, `${next.id}:${next.index}`].slice(-60);
    setQuip({ ...next, status });
    setSpins(count => count + 1);
  };
  return <section className="insight insight-mascot" data-insight="mascot" data-mood={mood} aria-label={t('看板娘')}
    style={focus ? { '--accent': focus.color } as CSSProperties : undefined}>
    {views.length > 0 && <button type="button" className="mascot-refresh" data-spin={spins > 0 || undefined} title={t('换一句')} aria-label={t('换一句')} onClick={refresh}>
      <RefreshCw key={spins} aria-hidden="true" />
    </button>}
    {focus && <button type="button" className="mascot-figure" title={t('打开 {p0}', { p0: focus.name })} aria-label={t('打开 {p0}', { p0: focus.name })} onClick={() => onOpen(focus!)}>
      <Portrait provider={focus.provider} image={image(focus)} anime={anime} crop="bust" />
      {mood === 'rest' && <span className="mascot-zzz" aria-hidden="true">z<i>z</i><b>z</b></span>}
    </button>}
    <p className="mascot-bubble" role="status"><span key={line} lang={english ? 'en' : undefined} dir={english ? 'ltr' : undefined}>{line}</span></p>
  </section>;
}

type PanelProps = { views: ProviderView[]; journal: Journal; anime: boolean; image: (view: ProviderView) => string | undefined; onOpen: (view: ProviderView) => void };

export function InsightsArea({ insights, height, width, ...props }: PanelProps & { insights: Insights; height: number; width: number }) {
  const { t } = useI18n();
  const ids = ORDER.filter(id => insights[id] && (id !== 'mascot' || props.anime));
  if (!ids.length) return null;
  return <div className={`insights ${width >= WIDE ? 'is-wide' : ''}`} style={{ height }} data-count={ids.length} role="region" aria-label={t('下半屏')} tabIndex={0}>
    {ids.map(id => id === 'timeline' ? <Timeline key={id} {...props} /> : id === 'resets' ? <Resets key={id} {...props} />
      : id === 'trend' ? <Trend key={id} {...props} /> : <Mascot key={id} {...props} />)}
  </div>;
}
