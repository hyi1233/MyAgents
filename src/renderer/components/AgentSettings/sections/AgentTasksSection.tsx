// Agent tasks section — read-only display of cron tasks associated with this agent
import { useState, useEffect } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import { getAllCronTasks } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { getCronStatusText, formatScheduleDescription } from '@/types/cronTask';

function cronStatusDotColor(status: string): string {
  if (status === 'running') return 'var(--success)';
  return 'var(--ink-subtle)';
}

interface AgentTasksSectionProps {
  agent: AgentConfig;
}

export default function AgentTasksSection({ agent }: AgentTasksSectionProps) {
  const [tasks, setTasks] = useState<CronTask[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const all = await getAllCronTasks();
        // Filter tasks by agent's channel IDs (sourceBotId matches channel ID)
        const channelIds = new Set(agent.channels.map(ch => ch.id));
        setTasks(all.filter(t => t.sourceBotId && channelIds.has(t.sourceBotId)));
      } catch {
        // Silent — tasks are optional
      }
    })();
  }, [agent.channels]);

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium text-[var(--ink)]">
        定时任务
      </h3>

      {tasks.length === 0 ? (
        <p className="text-xs text-[var(--ink-subtle)]">
          暂无与此 Agent 关联的定时任务。
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5"
            >
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: cronStatusDotColor(task.status) }}
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium truncate text-[var(--ink)]">
                  {task.name || '未命名任务'}
                </span>
                <div className="text-xs text-[var(--ink-subtle)]">
                  {formatScheduleDescription(task)} · {getCronStatusText(task.status)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
