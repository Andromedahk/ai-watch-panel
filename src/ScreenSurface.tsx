import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from './i18n';
import { useScreenText } from './screen-i18n';
import { screenLayout } from './screen-layout';
import { screenAttentionQueue } from './screen-attention';
import { Portrait } from './view/parts';
import type { Provider, Skin } from './types';
import type { ProviderView } from './view/model';

type Props = {
  providers: Provider[]; views: ProviderView[]; stream: { pageSeconds: number; showMascot: boolean };
  skin: Skin; anime: boolean; animate: boolean; testing: boolean; demo?: boolean; remote?: boolean; sampledAt?: string | null;
  renderCard: (view: ProviderView, index: number, visible: boolean) => ReactNode;
  renderMascot?: ReactNode;
  renderTrend?: ReactNode;
  imageForAttention?: (provider: Provider) => string | undefined;
};

// Only structured, current task state can interrupt the display. An expired login,
// unavailable accessibility permission, or an old task title is not an Agent request.
export function waitingProviders(providers: Provider[]) {
  return [...new Set(screenAttentionQueue(providers).map(item => item.provider))];
}

function useRotation(seconds: number, key: string, count: number) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [key]);
  useEffect(() => {
    if (count < 2) return;
    const timer = window.setInterval(() => setIndex(current => current + 1), Math.max(4, seconds) * 1000);
    return () => clearInterval(timer);
  }, [seconds, key, count]);
  return index;
}

export function ScreenSurface({ providers, views, stream, skin, anime, animate, testing, demo = false, remote = false, sampledAt, renderCard, renderMascot, renderTrend, imageForAttention }: Props) {
  const { t, date, number } = useI18n();
  const s = useScreenText();
  const [size, setSize] = useState(() => ({ width: innerWidth, height: innerHeight }));
  useEffect(() => {
    const update = () => setSize({ width: innerWidth, height: innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const mascot = Boolean(stream.showMascot && views.length && renderMascot);
  const layout = screenLayout(size.width, size.height, views.length, mascot);
  const pages = Math.max(1, Math.ceil(views.length / layout.capacity));
  const providerKey = views.map(view => view.id).join(',');
  const page = useRotation(stream.pageSeconds, `${providerKey}:${layout.capacity}`, pages);
  const currentPage = page % pages;
  const visibleCount = Math.min(layout.capacity, Math.max(1, views.length - currentPage * layout.capacity));
  const columns = Math.min(layout.columns, visibleCount);
  const rows = Math.ceil(visibleCount / columns);
  const waiting = screenAttentionQueue(providers);
  const waitingKey = JSON.stringify(waiting.map(item => item.key));
  const attentionPage = useRotation(6, waitingKey, waiting.length);
  const reminder = waiting.length ? waiting[attentionPage % waiting.length] : null;
  const attention = reminder?.provider;
  const attentionLabels = reminder?.reason === 'both' ? [t('待回答'), t('待授权')]
    : [reminder?.reason === 'input' ? t('待回答') : reminder?.reason === 'approval' ? t('待授权') : t('待确认')];
  return <main className={`screen-surface skin-${skin} ${anime ? 'anime-mode' : ''} ${!animate ? 'no-animation' : ''}`}
    data-surface="screen" data-test-mode={testing} data-page={currentPage + 1} data-attention-count={waiting.length}
    data-portrait={layout.portrait} data-visible-cards={visibleCount} data-screen-profile="curved-dual-face"
    style={{ '--screen-cols': columns, '--screen-rows': rows } as CSSProperties}>
    <div className="screen-content" data-has-mascot={mascot} aria-hidden={Boolean(attention)}>
      <section className="screen-agent-module" aria-label={s('Agent 监看模块', 'Agent monitoring modules')}>
        <header className="screen-module-heading"><strong>AI WATCH</strong>
          <span>{testing ? t('测试数据') : remote ? t('同步') : demo ? t('演示') : t('本地')} · {number(currentPage + 1)} / {number(pages)}</span>
          {sampledAt && <time>{date(sampledAt, { hour: '2-digit', minute: '2-digit' })}</time>}
        </header>
        <div className="screen-card-grid">
          {views.map((view, index) => renderCard(view, index, index >= currentPage * layout.capacity && index < (currentPage + 1) * layout.capacity))}
          {!views.length && <div className="screen-empty"><strong>{t('尚未启用模块')}</strong><p>{s('请在桌面配置页选择监看模块', 'Select monitoring modules in desktop settings')}</p></div>}
        </div>
        {pages > 1 && <div className="screen-page-indicator" aria-label={s('模块自动轮播', 'Automatic module rotation')}>{Array.from({ length: pages }, (_, index) => <span key={index} data-current={index === currentPage} />)}</div>}
      </section>
      <aside className="screen-sidebar" data-has-mascot={mascot}>
        {mascot && <div className="screen-mascot" aria-label={s('二次元看板娘模块', 'Anime companion module')}>{renderMascot}</div>}
        <div className="screen-trend" aria-label={s('额度历史曲线', 'Quota history chart')}>{renderTrend}</div>
      </aside>
    </div>
    {attention && reminder && <section key={reminder.key} className={`screen-attention ${waiting.length > 1 ? 'screen-attention-rotating' : ''}`} role="alert" aria-live="assertive" aria-atomic="true"
      data-provider={attention.id} data-reason={reminder.reason} data-reminder-key={reminder.key} data-attention-index={attentionPage % waiting.length}>
      <div className="screen-attention-character" key={attention.id} style={{ '--accent': attention.color } as CSSProperties}>
        <div className="screen-attention-orbit" aria-hidden="true" />
        <Portrait provider={attention} image={imageForAttention?.(attention)} anime crop="bust" />
      </div>
      <div className="screen-attention-content">
        <span className="screen-attention-kicker">{testing ? `${t('测试数据')} · ` : ''}AGENT NEEDS YOU</span>
        <strong className="screen-attention-provider">{attention.name}</strong>
        <h1 data-lines={attentionLabels.length}>{attentionLabels.map(label => <span key={label}>{label}</span>)}</h1>
        {reminder.title && <div className="screen-attention-task">{reminder.title}</div>}
        <p>{s(`请在电脑上的 ${attention.name} 中处理`, `Respond in ${attention.name} on your computer`)}</p>
        <span className="screen-attention-note">{s('请求处理完成后自动恢复监看画面', 'Monitoring resumes when the request is resolved')}</span>
        <div className="screen-attention-queue">{number(waiting.length)} {s('项待处理', 'pending request(s)')}{waiting.length > 1 && ` · ${number(attentionPage % waiting.length + 1)} / ${number(waiting.length)}`}</div>
      </div>
      {waiting.length > 1 && <div className="screen-attention-progress" aria-hidden="true"><span key={`${waitingKey}:${attentionPage}`} /></div>}
    </section>}
  </main>;
}
