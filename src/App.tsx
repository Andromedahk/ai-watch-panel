import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, ArrowLeftToLine, ArrowRightToLine, Check, ChevronLeft, ChevronRight, GripVertical, LockKeyhole, MapPin, RefreshCw, Settings2, UnlockKeyhole, X } from 'lucide-react';
import { providers } from './data';
import type { PanelState, Preferences, Provider, ProviderId } from './types';

const previewState: PanelState = {
  side: 'right', locked: false, animate: true, collapsed: false,
  desktop: false, platform: 'browser', scaleFactor: window.devicePixelRatio,
};
function readImages(): Partial<Record<ProviderId, string>> {
  try { return JSON.parse(localStorage.getItem('ai-watch:images') ?? '{}'); }
  catch { return {}; }
}
function Avatar({ provider, image }: { provider: Provider; image?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  return <div className="avatar">
    {failed ? <span>{provider.name.slice(0, 1)}</span> : <img src={image || `./${provider.image}`} alt={`${provider.name} 助手图片`} onError={() => setFailed(true)} />}
  </div>;
}
function ProviderCard({ provider, index, image }: { provider: Provider; index: number; image?: string }) {
  return <section className={`provider-card ${provider.running ? 'is-running' : ''}`} style={{ '--accent': provider.color } as CSSProperties} aria-label={`${provider.name} 面板`}>
    <div className="card-heading">
      <Avatar provider={provider} image={image} />
      <div className="identity"><span className="eyebrow">{provider.subtitle}</span><h2>{provider.name}</h2></div>
      <span className="card-index">0{index + 1}</span>
    </div>
    <div className="quota-list" aria-label="演示剩余额度">
      {provider.quotas.map((quota) => <div className="quota" key={quota.model} title={quota.reset}>
        <div className="quota-label"><span>{quota.model}<small>{quota.period}</small></span><strong><span className="remaining-label">剩余</span>{quota.remaining}<em>%</em></strong></div>
        <div className="quota-track" role="progressbar" aria-label={`${quota.model} ${quota.period} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.remaining}>
          <div className={`quota-fill ${quota.remaining < 30 ? 'is-low' : ''}`} style={{ width: `${quota.remaining}%` }} />
        </div>
      </div>)}
    </div>
    <div className="task-line"><span className={`status-dot ${provider.running ? 'active' : ''}`} /><span>{provider.task}</span><span className="task-status">{provider.running ? '运行中' : '待机'}</span></div>
  </section>;
}

export default function App() {
  const [state, setState] = useState(previewState);
  const [images, setImages] = useState(readImages);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState('演示数据');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Preferences>(previewState);
  const modal = useRef<HTMLDialogElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetImage = useRef<ProviderId>('claude');

  useEffect(() => {
    const bridge = window.panel;
    if (!bridge) return;
    bridge.getState().then(setState).catch(() => setNotice('无法读取窗口状态'));
    return bridge.onState(setState);
  }, []);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (settingsOpen) modal.current?.showModal();
    else modal.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b' && !state.desktop) {
        event.preventDefault(); setState((old) => ({ ...old, collapsed: !old.collapsed }));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state.desktop]);

  async function toggleLock() {
    try {
      if (window.panel) setState(await window.panel.setLocked(!state.locked));
      else { setState({ ...state, locked: !state.locked }); setNotice('浏览器预览：锁定效果请在桌面版查看'); }
    } catch { setNotice('窗口锁定失败，请重试'); }
  }
  async function collapse(value: boolean) {
    try {
      if (window.panel) setState(await window.panel.setCollapsed(value));
      else setState({ ...state, collapsed: value });
    } catch { setNotice('窗口收起失败，请重试'); }
  }
  function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    refreshTimer.current = setTimeout(() => {
      setRefreshing(false);
      setLastRefresh(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      setNotice('界面已刷新 · 当前为演示数据');
    }, 650);
  }
  async function saveSettings() {
    try {
      if (window.panel) setState(await window.panel.configure(draft));
      else setState({ ...state, ...draft });
      setSettingsOpen(false); setNotice('配置已保存');
    } catch { setNotice('保存失败，请重试'); }
  }
  function storeImage(provider: ProviderId, value: string) {
    const next = { ...images, [provider]: value };
    try { localStorage.setItem('ai-watch:images', JSON.stringify(next)); setImages(next); }
    catch { setNotice('图片存储空间不足，请使用更小的图片'); }
  }
  async function chooseImage(provider: ProviderId) {
    try {
      if (window.panel) {
        const value = await window.panel.chooseImage(provider);
        if (value) storeImage(provider, value);
      } else { targetImage.current = provider; fileInput.current?.click(); }
    } catch { setNotice('无法读取图片，请选择 8 MB 以内的 PNG、JPG 或 WebP'); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setNotice('请选择 8 MB 以内的 PNG、JPG 或 WebP'); return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
    });
    const image = new Image(); image.src = dataUrl;
    try {
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = Math.round(256 * image.height / image.width);
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      storeImage(targetImage.current, canvas.toDataURL('image/png'));
    } catch { setNotice('无法读取这张图片'); }
  }

  return <main className={`panel ${state.collapsed ? 'collapsed' : ''} ${!state.animate ? 'no-animation' : ''}`}>
    {state.collapsed ? <aside className="collapsed-rail" aria-label="收起的监看面板">
      <div className="rail-grip"><GripVertical size={15} /></div>
      <button className="rail-expand" title="展开面板" aria-label="展开面板" onClick={() => collapse(false)}>{state.side === 'right' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}</button>
      <span className="rail-brand">AI</span>
      <div className="rail-providers">{providers.map((provider) => <div key={provider.id} title={`${provider.name} · ${provider.running ? '演示运行中' : '演示待机'}`} style={{ '--accent': provider.color } as CSSProperties}>
        <Avatar provider={provider} image={images[provider.id]} /><span className={`status-dot ${provider.running ? 'active' : ''}`} />
      </div>)}</div>
      <button className={`rail-lock ${state.locked ? 'selected' : ''}`} title="锁定窗口" aria-label="锁定窗口" aria-pressed={state.locked} onClick={toggleLock}>{state.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button>
      <span className="rail-demo">演示</span>
    </aside> : <div className="panel-regions">
      <header className="control-region">
        <div className="brand-line"><div className="brand"><Activity size={15} strokeWidth={1.7} /><h1>AI WATCH</h1></div><GripVertical size={13} className="drag-hint" /></div>
        <div className="overview"><span><span className="tiny-dot" />2 项运行 <span className="demo-tag">演示</span></span><time>{lastRefresh}</time></div>
        <nav className="toolbar" aria-label="面板控制">
          <button className={state.locked ? 'selected' : ''} aria-label="锁定窗口" aria-pressed={state.locked} title={state.locked ? '解除跨桌面锁定' : '锁定：置顶并显示在所有桌面'} onClick={toggleLock}>{state.locked ? <LockKeyhole /> : <UnlockKeyhole />}</button>
          <button aria-label="收起面板" title="收起为状态窄条" onClick={() => collapse(true)}>{state.side === 'right' ? <ArrowRightToLine /> : <ArrowLeftToLine />}</button>
          <button aria-label="刷新面板" title="刷新演示界面" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'spinning' : ''} /></button>
          <button aria-label="打开配置" title="配置面板" onClick={() => { setDraft(state); setSettingsOpen(true); }}><Settings2 /></button>
        </nav>
      </header>
      {providers.map((provider, index) => <ProviderCard key={provider.id} provider={provider} index={index} image={images[provider.id]} />)}
    </div>}
    <dialog ref={modal} className="settings-dialog" aria-labelledby="settings-title" onCancel={() => setSettingsOpen(false)}>
      <div className="settings-heading"><div><span className="eyebrow">PREFERENCES</span><h2 id="settings-title">面板配置</h2></div><button className="icon-button" aria-label="关闭配置" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
      <div className="settings-content">
        <fieldset><legend>默认停靠位置</legend><div className="segmented"><button className={draft.side === 'left' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'left' })}>左侧</button><button className={draft.side === 'right' ? 'selected' : ''} onClick={() => setDraft({ ...draft, side: 'right' })}>右侧</button></div></fieldset>
        <label className="switch-row"><span>跨桌面锁定<small>置顶并跟随桌面切换</small></span><input type="checkbox" checked={draft.locked} onChange={(event) => setDraft({ ...draft, locked: event.target.checked })} /></label>
        <label className="switch-row"><span>状态灯动画<small>运行中轻微呼吸效果</small></span><input type="checkbox" checked={draft.animate} onChange={(event) => setDraft({ ...draft, animate: event.target.checked })} /></label>
        <button className="dock-button" onClick={async () => {
          try { if (window.panel) setState(await window.panel.dock()); setNotice('已重新贴边'); }
          catch { setNotice('重新贴边失败'); }
        }}><MapPin size={14} />重新贴到屏幕边缘</button>
        <div className="settings-section"><h3>助手图片</h3><p>透明图片效果更好</p>{providers.map((provider) => <div className="image-option" key={provider.id} style={{ '--accent': provider.color } as CSSProperties}>
          <Avatar provider={provider} image={images[provider.id]} /><span>{provider.name}</span><button onClick={() => chooseImage(provider.id)} aria-label={`替换 ${provider.name} 图片`}>替换</button>
        </div>)}</div>
        <div className="settings-note"><span className="note-title">界面预览 · v0.1</span><p>额度与任务均为演示数据，尚未连接 AI 工具。DeepSeek 额度为自定义示例。</p><p>{state.desktop ? `桌面版 · 显示缩放 ${state.scaleFactor}×` : '浏览器预览 · 窗口操作请使用桌面版'}</p></div>
      </div>
      <div className="settings-footer"><button className="save-button" onClick={saveSettings}><Check size={15} />保存配置</button>{state.desktop && <button className="quit-button" onClick={() => window.panel?.quit()}>退出面板</button>}</div>
      {notice && settingsOpen && <div className="toast" role="status">{notice}</div>}
    </dialog>
    <input ref={fileInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
    {notice && !settingsOpen && <div className="toast" role="status">{notice}</div>}
  </main>;
}
