// Deliberate live acceptance only. Normal unit tests never invoke an AI model.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { AgentRelay } = require('../electron/relay/server.cjs');
const { AgentDispatcher } = require('../electron/relay/dispatcher.cjs');
if (process.env.AI_WATCH_LIVE_RELAY !== '1') throw new Error('Set AI_WATCH_LIVE_RELAY=1 to run four bounded Claude/Codex text-only compatibility turns using the local clients.');
const runId = randomUUID();
const directory = path.resolve('.local', 'qa', 'relay-live', runId);
const relay = new AgentRelay({ directory, port: 0 });
const dispatcher = new AgentDispatcher({ relay, directory: path.join(directory, 'managed') });
const bootstraps = [], startedAt = new Date().toISOString();
let report;
try {
  await relay.start();
  dispatcher.setEnabledAgents(['claude', 'codex']);
  for (const [source, target, marker] of [['claude', 'codex', 'CODEX_MCP_COMPAT_OK'], ['codex', 'claude', 'CLAUDE_MCP_COMPAT_OK']]) {
    const childKey = `live-${source}-${runId}`;
    const sent = await relay.ownerCommand(target, 'relay_send_task', {
      to: source, subject: `Human-initiated compatibility setup for ${source}`,
      purpose: `Human-requested test: ask ${source} to perform exactly one MCP handoff to ${target}. This setup record is created by the test operator, not a claim that ${target} initiated it.`,
      instructions: [
        `This is a deliberately bounded interoperability test. Call relay_send_task exactly once, addressed to ${target}.`,
        `Use subject: "Live ${source} to ${target} MCP compatibility".`,
        `Use purpose: "Verify one necessary task handoff from ${source} to ${target} and its readable result."`,
        `Use instructions: "Return exactly ${marker}. You may use relay_report_result to return this fixed text. Do not delegate, read files, run commands, or use unrelated tools."`,
        `Use acceptanceCriteria: ["The final result includes ${marker}."] and idempotencyKey: "${childKey}".`,
        'Use parentTaskId equal to the taskId of THIS setup task in the task data below.',
        'After the child is queued, finish THIS setup task with the child task ID. Do not wait or poll for the child. Do not send more tasks.'
      ].join('\n'), acceptanceCriteria: [`Exactly one child is queued to ${target} with the requested marker.`], idempotencyKey: `setup-${source}-${runId}`, ttlSeconds: 900,
    });
    if (!sent.ok) throw new Error('live-setup-failed');
    bootstraps.push({ source, target, marker, taskId: sent.task.id });
  }
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await dispatcher.tick();
    if (dispatcher.getState().agents.some(agent => !agent.available)) break;
    const tasks = await relay.ownerListTasks({ limit: 100 });
    const finished = bootstraps.every(entry => {
      const setup = tasks.find(task => task.id === entry.taskId);
      if (setup?.status === 'failed') return true;
      if (setup?.status !== 'completed') return false;
      const child = tasks.find(task => task.parentTaskId === entry.taskId && task.from === entry.source && task.to === entry.target);
      return child && ['completed', 'failed', 'cancelled', 'expired'].includes(child.status);
    });
    if (finished) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const tasks = await relay.ownerListTasks({ limit: 100 });
  const directions = bootstraps.map(entry => {
    const setup = tasks.find(task => task.id === entry.taskId);
    const children = tasks.filter(task => task.parentTaskId === entry.taskId && task.from === entry.source && task.to === entry.target);
    const child = children[0];
    const passed = setup?.status === 'completed' && children.length === 1 && child.status === 'completed'
      && `${child.result?.summary || ''}\n${child.result?.details || ''}`.includes(entry.marker);
    return { source: entry.source, target: entry.target, setupTaskId: entry.taskId, setupStatus: setup?.status || 'missing',
      childTaskId: child?.id || null, childStatus: child?.status || 'missing', passed, expectedResult: entry.marker };
  });
  report = { liveModels: true, runId, startedAt, completedAt: new Date().toISOString(), passed: directions.every(item => item.passed),
    directions, sessions: dispatcher.getState(), desktopWake: 'Not established. These are explicitly enabled, dedicated managed CLI sessions. No existing desktop runtime was controlled.' };
} finally {
  await dispatcher.stop();
  if (!report) report = { liveModels: true, runId, startedAt, passed: false, failure: 'The live test could not complete safely.' };
  report.sessions = dispatcher.getState();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'compatibility.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(path.join(directory, 'compatibility.md'), [
    '# AI Watch · Claude / Codex 实际 MCP 兼容验收', '',
    '用途：验证两种已安装官方客户端的专用托管会话能发起任务、消费任务并回报结果。只测试固定文本，不操作用户项目。', '',
    `开始：${startedAt}`, `结果：${report.passed ? '双向通过' : '未全部通过，请查看各方向的实际结果'}`, '',
    ...(report.directions || []).flatMap(item => [`## ${item.source} → ${item.target}`, '',
      `人工发起的准备任务：${item.setupTaskId}（${item.setupStatus}）`,
      `模型经 MCP 创建的子任务：${item.childTaskId || '未创建'}（${item.childStatus}）`,
      `预期固定结果：${item.expectedResult}`, `该方向通过：${item.passed ? '是' : '否'}`, '']),
    '完整必要任务、领取、进度和结果见同目录 transcript.md / events.jsonl。原始客户端调试输出、鉴权和思考过程不写入交流留档。', '',
    '范围：验证专用 CLI 会话。未据此声称 Claude Desktop 或 Codex App 的现有空闲会话已被第三方程序自动唤醒。', '',
  ].join('\n'), { mode: 0o600 });
  await relay.stop();
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
