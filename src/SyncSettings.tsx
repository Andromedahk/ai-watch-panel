// Settings for LAN sync: choose a role, share a pairing code as host, or pair a client.
import { useEffect, useState } from 'react';
import { useI18n } from './i18n';
import type { PanelState, SyncHost, SyncRole } from './types';

type Props = { state: PanelState; onState: (state: PanelState) => void; notify: (text: string) => void };

export function syncStatusText(state: PanelState, t: ReturnType<typeof useI18n>['t']) {
  const sync = state.lanSync;
  if (!sync || state.syncRole === 'off') return t('独立运行');
  if (state.syncRole === 'host') {
    if (sync.state === 'listening') return t('正在共享 · {p0} 台设备已连接', { p0: sync.connected ?? 0 });
    return sync.error === 'port-in-use' ? t('端口已被占用，请换一个端口') : t('共享未启动');
  }
  const host = sync.hostName || sync.address || '';
  return { connected: t('已连接到 {p0}', { p0: host }), connecting: t('正在连接 {p0}', { p0: host }), reconnecting: t('连接中断，正在重连'),
    unauthorized: t('配对已失效，请重新输入配对码'), unpaired: t('尚未配对') }[sync.state] ?? t('正在连接 {p0}', { p0: host });
}

export function SyncSettings({ state, onState, notify }: Props) {
  const { t } = useI18n();
  const sync = state.lanSync;
  const role = state.syncRole;
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<SyncHost[] | null>(null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [port, setPort] = useState(String(state.syncPort));
  useEffect(() => setPort(String(state.syncPort)), [state.syncPort]);

  async function run(action: (bridge: NonNullable<Window['panel']>) => Promise<PanelState | SyncHost[]>, failure: (error: unknown) => string) {
    if (!window.panel || busy) return;
    setBusy(true);
    try {
      const result = await action(window.panel);
      if (Array.isArray(result)) setHosts(result); else onState(result);
    } catch (error) { notify(failure(error)); }
    finally { setBusy(false); }
  }
  const pairFailure = (error: unknown) => {
    const message = String((error as Error)?.message || '');
    return message.includes('wrong-code') ? t('配对码不正确') : message.includes('rate-limited') ? t('尝试次数过多，请稍后再试')
      : message.includes('bad-address') || message.includes('not-private') ? t('请输入局域网地址，例如 192.168.1.20:47321') : t('无法连接主客户端，请检查地址和网络');
  };
  const roles: [SyncRole, string][] = [['off', t('独立')], ['host', t('主客户端')], ['client', t('子客户端')]];
  const needsPairing = role === 'client' && (!sync?.paired || sync.state === 'unauthorized');

  return <section className="settings-group" data-section="sync"><h3>{t('多端同步')}</h3>
    <fieldset><legend>{t('本机角色')}</legend>
      <div className="segmented" aria-label={t('本机角色')}>{roles.map(([id, label]) => <button key={id} className={role === id ? 'selected' : ''} aria-pressed={role === id}
        disabled={!state.desktop || busy} onClick={() => void run(bridge => bridge.setSyncRole(id), () => t('同步设置保存失败，请重试'))}>{label}</button>)}</div>
      <p className="appearance-hint">{role === 'host' ? t('主客户端在局域网内共享状态、额度、提醒和动态记录；只有输入配对码的设备可以连接。')
        : role === 'client' ? t('子客户端停止读取本机助手，只显示主客户端同步的数据；外观、语言和布局保留本机设置，打开应用等操作需在主客户端完成。')
          : t('独立运行，不与其他设备通信。')}</p>
      {role !== 'off' && <p className="sync-status" role="status" data-sync-state={sync?.state}>{syncStatusText(state, t)}</p>}
    </fieldset>
    {role === 'host' && sync && <fieldset><legend>{t('配对码')}</legend>
      <p className="sync-code" aria-label={t('配对码')}><bdi>{sync.code}</bdi></p>
      <p className="appearance-hint">{t('在子客户端输入以下任一地址和配对码：')}</p>
      <ul className="sync-addresses">{(sync.addresses?.length ? sync.addresses : ['—']).map(item => <li key={item}><bdi>{item === '—' ? t('未找到局域网地址') : `${item}:${sync.port ?? state.syncPort}`}</bdi></li>)}</ul>
      <p className="appearance-hint">{t('已配对 {p0} 台设备', { p0: typeof sync.paired === 'number' ? sync.paired : 0 })}</p>
      <label className="sync-field"><span>{t('端口')}</span><input aria-label={t('端口')} type="number" min={1024} max={65535} value={port} disabled={busy}
        onChange={event => setPort(event.target.value)} onBlur={() => {
          const value = Number(port);
          if (value === state.syncPort) return;
          if (!Number.isInteger(value) || value < 1024 || value > 65535) { setPort(String(state.syncPort)); notify(t('端口需在 1024–65535 之间')); return; }
          void run(bridge => bridge.setSyncPort(value), () => t('同步设置保存失败，请重试'));
        }} /></label>
      <button className="dock-button" disabled={busy} onClick={() => void run(bridge => bridge.regenerateSync(), () => t('同步设置保存失败，请重试'))}>{t('重置配对码并断开所有设备')}</button>
      <p className="appearance-hint">{t('只接受局域网地址，不共享登录凭据、密钥或本机文件路径。首次开启时系统可能询问是否允许 AI Watch 接受传入连接，请选择允许。')}</p>
    </fieldset>}
    {role === 'client' && sync && <fieldset><legend>{t('主客户端')}</legend>
      {!needsPairing ? <>
        <p className="appearance-hint"><bdi>{sync.hostName || ''}</bdi>{sync.address && <> · <bdi>{sync.address}</bdi></>}</p>
        <button className="dock-button" disabled={busy} onClick={() => void run(bridge => bridge.forgetSync(), () => t('同步设置保存失败，请重试'))}>{t('断开并忘记主客户端')}</button>
      </> : <>
        <button className="dock-button" disabled={busy || !state.desktop} onClick={() => void run(bridge => bridge.discoverSync(), () => t('搜索失败，可手动输入地址'))}>{t('搜索局域网主客户端')}</button>
        {hosts && (hosts.length ? <ul className="sync-hosts">{hosts.map(host => <li key={`${host.address}:${host.port}`}>
          <button type="button" aria-pressed={address === `${host.address}:${host.port}`} onClick={() => setAddress(`${host.address}:${host.port}`)}>
            <strong><bdi>{host.name || host.address}</bdi></strong><small><bdi>{host.address}:{host.port}</bdi></small></button></li>)}</ul>
          : <p className="appearance-hint">{t('没有找到主客户端，可手动输入地址')}</p>)}
        <label className="sync-field"><span>{t('主客户端地址')}</span><input aria-label={t('主客户端地址')} placeholder="192.168.1.20:47321" value={address} maxLength={80} spellCheck={false}
          onChange={event => setAddress(event.target.value)} /></label>
        <label className="sync-field"><span>{t('配对码')}</span><input aria-label={t('配对码')} inputMode="numeric" autoComplete="off" maxLength={6} value={code}
          onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        <button className="dock-button" disabled={busy || !address.trim() || code.length !== 6}
          onClick={() => void run(async bridge => { const next = await bridge.pairSync(address.trim(), code); setCode(''); return next; }, pairFailure)}>{t('连接')}</button>
      </>}
    </fieldset>}
  </section>;
}
