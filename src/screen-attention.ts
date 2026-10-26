import type { Provider } from './types';

export type ScreenAttention = {
  key: string;
  provider: Provider;
  reason: 'input' | 'approval' | 'both' | 'waiting';
  title: string | null;
};

// Current task details deliberately omit source IDs and question/tool arguments.
// Use the safe title plus reason as a display identity, with an occurrence for
// indistinguishable duplicates. Timestamps and detail ordering change on polls
// and must not restart a six-second rotation. Renaming a task creates a new item.
export function screenAttentionQueue(providers: Provider[]): ScreenAttention[] {
  return providers.flatMap<ScreenAttention>(provider => {
    const local = provider.local;
    if (!local) return [];
    const tasks = local.taskDetails?.filter(task => task.state === 'waiting' && !task.stale) || [];
    if (local.activity !== 'waiting' && !(local.waitingTasks && local.waitingTasks > 0) && !tasks.length) return [];

    const aggregateReason = local.waitingReason || 'waiting';
    if (!tasks.length) return [{
      key: JSON.stringify([provider.id, 'aggregate', aggregateReason]),
      provider, reason: aggregateReason, title: null,
    }];

    const occurrences = new Map<string, number>();
    return tasks.map<ScreenAttention>(task => {
      // Only this approval operation currently crosses the task-detail bridge.
      // Other operations (including agentMessage/toolCall) do not identify the
      // kind of question. Retain the aggregate reason instead of guessing from
      // a title or labelling every non-approval operation as a request for input.
      const reason = task.operation === 'approval/asked' ? 'approval' : aggregateReason;
      const title = task.title?.trim() || null;
      const identity = JSON.stringify([provider.id, 'task', reason, title]);
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      return { key: JSON.stringify([identity, occurrence]), provider, reason, title };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
