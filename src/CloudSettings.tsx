import { useEffect, useState } from 'react';
import { useI18n } from './i18n';
import type { PanelState } from './types';

export function CloudSettings({ state, onState, notify }: { state: PanelState; onState: (value: PanelState) => void; notify: (text: string) => void }) {
  const { t, date, number } = useI18n();
  const cloud = state.cloudSync;
  const [endpoint, setEndpoint] = useState(cloud?.endpoint || '');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(cloud?.enabled || false);
  const [allowActions, setAllowActions] = useState(cloud?.allowActions || false);
  const [uploadFullContent, setUploadFullContent] = useState(cloud?.uploadFullContent || false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEndpoint(cloud?.endpoint || ''); setEnabled(cloud?.enabled || false); setAllowActions(cloud?.allowActions || false); setUploadFullContent(cloud?.uploadFullContent || false); }, [cloud?.endpoint, cloud?.enabled, cloud?.allowActions, cloud?.uploadFullContent]);
  const disabled = !state.desktop || busy;
  async function save(forget = false) {
    if (!window.panel || busy) return;
    setBusy(true);
    try {
      onState(forget ? await window.panel.forgetCloud() : await window.panel.configureCloud({ enabled, endpoint: endpoint.trim(), token, allowActions, uploadFullContent: allowActions && uploadFullContent }));
      setToken(''); notify(t('云端配置已保存'));
    } catch (error) {
      notify(String(error).includes('secure-storage-unavailable') ? t('系统安全存储不可用，无法保存云端凭据') : t('云端配置保存失败，请检查 HTTPS 地址和凭据'));
    } finally { setBusy(false); }
  }
  return <section className="settings-group" data-section="cloud"><h3>{t('云端同步状态')}</h3>
    <fieldset disabled={disabled}>
      <label className="sync-field"><span>{t('云端服务器')}</span><input aria-label={t('云端服务器')} placeholder="https://sync.example.com" type="url" value={endpoint} autoComplete="off" maxLength={2048} onChange={event => setEndpoint(event.target.value)} /></label>
      <label className="sync-field"><span>{t('桌面端凭据')}</span><input aria-label={t('桌面端凭据')} type="password" value={token} autoComplete="new-password" maxLength={512} placeholder={cloud?.configured ? t('已保存；留空保留') : ''} onChange={event => setToken(event.target.value)} /></label>
      <label className="switch-row"><span>{t('启用云端同步')}</span><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></label>
      <label className="switch-row"><span>{t('允许手机回答和授权')}</span><input type="checkbox" checked={allowActions} onChange={event => setAllowActions(event.target.checked)} /></label>
      <label className="switch-row"><span>{t('上传完整内容')}</span><input type="checkbox" checked={uploadFullContent} disabled={!allowActions} onChange={event => setUploadFullContent(event.target.checked)} /></label>
      <p className="appearance-hint">{t('默认关闭。开启后会上传待处理问题、选项、命令、原因和工作路径原文，手机可查看完整内容；请求结束或过期后从服务器删除。锁屏和灵动岛继续显示通用提醒。')}</p>
      {state.syncRole === 'client' && <p className="appearance-hint">{t('局域网子客户端只转发状态，不能远程操作主客户端。')}</p>}
      <button type="button" className="dock-button" onClick={() => void save()}>{t('保存云端配置')}</button>
      {cloud?.configured && <button type="button" className="dock-button" onClick={() => void save(true)}>{t('停用并清除本机凭据')}</button>}
    </fieldset>
    <p className="sync-status" role="status" data-cloud-state={cloud?.state || 'off'}>{t(cloud?.state === 'connected' ? '云端已连接' : cloud?.state === 'connecting' ? '正在连接云端' : cloud?.state === 'error' ? '云端连接失败' : '云端同步未启用')}</p>
    {cloud?.error && <p className="appearance-hint">{cloud.error}</p>}
    {cloud?.lastSyncedAt && <p className="appearance-hint">{t('最近同步：{p0} · 包体 {p1} B', { p0: date(new Date(cloud.lastSyncedAt).toISOString()), p1: number(cloud.lastBytes) })}</p>}
  </section>;
}
