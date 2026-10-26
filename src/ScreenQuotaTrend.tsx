import { useEffect, useState, type CSSProperties } from 'react';
import { useI18n } from './i18n';
import { useScreenText } from './screen-i18n';
import { screenTrendPoint, screenTrendSeries } from './screen-trend-data';
import type { Journal } from './journal';
import type { ProviderView } from './view/model';
import './screen-trend.css';

type Props = { views: ProviderView[]; journal: Journal; testing?: boolean; demo?: boolean; pageSeconds?: number };

/** Read-only 24-hour quota history for the lower half of the curved display. */
export function ScreenQuotaTrend({ views, journal, testing = false, demo = false, pageSeconds = 12 }: Props) {
  const { t, percent, number } = useI18n();
  const s = useScreenText();
  const [now, setNow] = useState(Date.now);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  // New readings must be admitted immediately, without waiting for the axis clock.
  const currentTime = Math.max(now, Date.now());
  const series = screenTrendSeries(views, journal, currentTime);
  const key = series.map(row => row.view.id).join(',');
  const pages = Math.max(1, Math.ceil(series.length / 4));
  useEffect(() => setPage(0), [key]);
  useEffect(() => {
    if (pages < 2) return;
    const timer = setInterval(() => setPage(current => current + 1), Math.max(4, pageSeconds) * 1000);
    return () => clearInterval(timer);
  }, [pages, pageSeconds, key]);
  const selected = series.slice(page % pages * 4, (page % pages + 1) * 4);
  return <section className="screen-quota-trend" data-series-count={selected.length} data-history-empty={!series.length}
    data-history-page={page % pages + 1} aria-label={s('额度历史曲线', 'Quota history')}>
    <header className="screen-trend-heading">
      <h2>{s('额度历史', 'Quota history')}</h2>
      <span>{testing ? t('测试数据') : demo ? t('演示') : s('近 24 小时', 'Last 24 hours')}</span>
    </header>
    <div className="screen-trend-chart" dir="ltr">
      <div className="screen-trend-y-axis" aria-hidden="true"><span>{percent(100)}</span><span>{percent(50)}</span><span>{percent(0)}</span></div>
      <div className="screen-trend-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[3, 50, 97].map(y => <line key={y} className="screen-trend-grid" x1="1" x2="99" y1={y} y2={y} vectorEffect="non-scaling-stroke" />)}
          {selected.map(({ view, points }) => {
            const coordinates = points.map(point => screenTrendPoint(point, currentTime));
            const [x, y] = coordinates[coordinates.length - 1];
            return <g key={view.id} className="screen-trend-series" data-provider={view.id} data-current={points[points.length - 1][1]} style={{ '--accent': view.color } as CSSProperties}>
              {points.length > 1 && <polyline className="screen-trend-line" points={coordinates.map(([px, py]) => `${px.toFixed(3)},${py.toFixed(3)}`).join(' ')} vectorEffect="non-scaling-stroke" />}
              <circle className="screen-trend-point" cx={x} cy={y} r=".75" vectorEffect="non-scaling-stroke" />
            </g>;
          })}
        </svg>
        {!series.length && <p className="screen-trend-empty">{t('记录中，稍后显示趋势')}</p>}
      </div>
      <div className="screen-trend-x-axis" aria-hidden="true"><span>−24h</span><span>−12h</span><span>{s('现在', 'Now')}</span></div>
    </div>
    <ul className="screen-trend-legend">
      {selected.map(({ view, points }) => <li key={view.id} data-provider={view.id} data-current={points[points.length - 1][1]} style={{ '--accent': view.color } as CSSProperties}>
        <i aria-hidden="true" /><bdi className="screen-trend-name">{view.name}</bdi><strong>{percent(points[points.length - 1][1])}</strong>
      </li>)}
    </ul>
    <footer className="screen-trend-caption"><span>{s('各 Agent 最低剩余额度', 'Lowest remaining quota per Agent')}</span>
      {pages > 1 && <bdi>{number(page % pages + 1)} / {number(pages)}</bdi>}
    </footer>
  </section>;
}
