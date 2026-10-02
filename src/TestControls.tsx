import { providers } from './data';
import { activityOptions, dataOptions, type TestConfig, type TestPreset, type TestSelection } from './test-mode';
import type { ProviderId } from './types';

type Props = {
  enabled: boolean; config: TestConfig;
  onToggle: (enabled: boolean) => void;
  onChange: (id: ProviderId, patch: Partial<TestSelection>) => void;
  onPreset: (preset: TestPreset) => void;
  onView: () => void;
};
export function TestControls({ enabled, config, onToggle, onChange, onPreset, onView }: Props) {
  return <section className={`test-controls ${enabled ? 'enabled' : ''}`} aria-label="界面测试">
    <label className="switch-row test-toggle"><span>测试模式<small>手动预览状态、额度与余额</small></span>
      <input type="checkbox" aria-label="测试模式" checked={enabled} onChange={event => onToggle(event.target.checked)} />
    </label>
    {enabled && <>
      <p className="test-hint">当前显示测试数据。选择后即时生效，重启后自动关闭。</p>
      <div className="test-presets" aria-label="测试快捷场景">
        <button onClick={() => onPreset('running')}>全部运行</button><button onClick={() => onPreset('idle')}>全部待机</button>
        <button onClick={() => onPreset('input')}>Codex 待回答</button><button onClick={() => onPreset('approval')}>Codex 待授权</button>
      </div>
      {providers.map(provider => <fieldset className="test-provider" key={provider.id}>
        <legend>{provider.name}</legend>
        <label><span>任务状态</span><select aria-label={`${provider.name} 测试任务状态`} value={config[provider.id].activity}
          onChange={event => onChange(provider.id, { activity: event.target.value as TestSelection['activity'] })}>
          {activityOptions(provider.id).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label><span>{provider.id === 'deepseek' ? '余额显示' : ['qwen', 'workbuddy'].includes(provider.id) ? '套餐 / 积分' : '套餐 / 额度'}</span><select aria-label={`${provider.name} 测试数据显示`} value={config[provider.id].data}
          onChange={event => onChange(provider.id, { data: event.target.value as TestSelection['data'] })}>
          {dataOptions(provider.id).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </fieldset>)}
      <button className="test-view" onClick={onView}>查看测试面板</button>
      <details className="test-checklist"><summary>手动检查项目</summary>
        <ul><li>运行配色、5 秒呼吸、Codex 红灯及恢复。</li><li>点击额度翻页、余额币种切换，悬停查看详情。</li><li>收起与展开、刷新提示、锁定与手动拖动。</li><li>下方设置中的左右停靠、动画开关与图片替换。</li></ul>
        <p>窗口与图片操作正常生效；刷新只更新测试画面。本地监看继续在后台更新，关闭测试模式后恢复显示。</p>
      </details>
    </>}
  </section>;
}
