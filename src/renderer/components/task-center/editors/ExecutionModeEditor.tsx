// ExecutionModeEditor — shared UI for picking how a task runs:
//   • mode: once / scheduled / recurring / loop
//   • scheduled → datetime-local
//   • recurring → interval in minutes
//   • recurring/loop → session strategy (new-session / single-session,
//     forced single-session for loop)
//
// Used by both the dispatch dialog (create flow) and the task detail overlay
// edit mode, so the two surfaces stay aligned on scheduling semantics.

import { useMemo, useState } from 'react';
import { Calendar, Clock, Play, Repeat, Timer } from 'lucide-react';

import type { TaskExecutionMode, TaskRunMode } from '@/../shared/types/task';
import { INPUT_CLS, PillButton, toLocalDateTimeString } from './controls';

export interface ExecutionModeState {
  executionMode: TaskExecutionMode;
  runMode: TaskRunMode;
  atDateTime: string;
  intervalMinutes: number;
}

export interface ExecutionModeEditorProps extends ExecutionModeState {
  setExecutionMode: (m: TaskExecutionMode) => void;
  setRunMode: (m: TaskRunMode) => void;
  setAtDateTime: (s: string) => void;
  setIntervalMinutes: (n: number) => void;
  disabled?: boolean;
  /**
   * When set, the "周期间隔" field is replaced with a read-only note — used
   * by the task detail edit mode where the interval lives on the linked
   * CronTask, not the Task itself, and so can't be written through
   * `cmd_task_update`. Users edit the interval via the cron panel
   * (or by dispatching a fresh task).
   */
  intervalReadOnlyNote?: string;
}

const EXECUTION_TABS: Array<{
  value: TaskExecutionMode;
  label: string;
  icon: typeof Clock;
  description: string;
}> = [
  {
    value: 'once',
    label: '立即执行',
    icon: Play,
    description: '创建后立刻开始执行；任务会出现在右侧任务列表。',
  },
  {
    value: 'scheduled',
    label: '定时一次',
    icon: Calendar,
    description: '在指定时间触发一次，然后停止',
  },
  {
    value: 'recurring',
    label: '周期触发',
    icon: Timer,
    description: '每隔固定时间触发一次，可设置结束条件',
  },
  {
    value: 'loop',
    label: 'Ralph Loop',
    icon: Repeat,
    description: '完成后立即下一轮（同会话持续打磨），必须设置退出条件',
  },
];

export function ExecutionModeEditor({
  executionMode,
  runMode,
  atDateTime,
  intervalMinutes,
  setExecutionMode,
  setRunMode,
  setAtDateTime,
  setIntervalMinutes,
  disabled,
  intervalReadOnlyNote,
}: ExecutionModeEditorProps) {
  const isScheduled = executionMode === 'scheduled';
  const isRecurring = executionMode === 'recurring';
  const isLoop = executionMode === 'loop';
  const showSessionStrategy = isRecurring || isLoop;

  const currentDescription = useMemo(
    () => EXECUTION_TABS.find((t) => t.value === executionMode)?.description,
    [executionMode],
  );

  // Pinned "now + 60s" — lazy-init so the `<input type=datetime-local>`
  // `min` attribute is stable across renders without calling the impure
  // `Date.now()` directly inside render. A stale floor by a few minutes is
  // fine (real validation runs on submit).
  const [minAtDateTime] = useState(() =>
    toLocalDateTimeString(new Date(Date.now() + 60_000)),
  );

  return (
    <div>
      <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
        {EXECUTION_TABS.map((t) => {
          const Icon = t.icon;
          const active = executionMode === t.value;
          return (
            <button
              key={t.value}
              type="button"
              disabled={disabled}
              onClick={() => setExecutionMode(t.value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2.5 text-[13px] text-[var(--ink-muted)]">{currentDescription}</p>

      {isScheduled && (
        <div className="mt-5">
          <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
            执行时间
          </label>
          <input
            type="datetime-local"
            value={atDateTime}
            onChange={(e) => setAtDateTime(e.target.value)}
            min={minAtDateTime}
            disabled={disabled}
            className={INPUT_CLS}
          />
        </div>
      )}

      {isRecurring && (
        <div className="mt-5">
          <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
            周期间隔（分钟）
          </label>
          {intervalReadOnlyNote ? (
            <p className="rounded-md border border-dashed border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
              {intervalReadOnlyNote}
            </p>
          ) : (
            <>
              <input
                type="number"
                min={5}
                max={10080}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Math.max(5, Number(e.target.value) || 5))}
                disabled={disabled}
                className={INPUT_CLS}
              />
              <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                最小 5 分钟。更复杂的 Cron 表达式请在详情 Overlay 中编辑。
              </p>
            </>
          )}
        </div>
      )}

      {showSessionStrategy && (
        <div className="mt-5">
          <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
            会话策略
          </label>
          {isLoop ? (
            <p className="text-sm text-[var(--ink-muted)]">
              连续对话（保持上下文）— Ralph Loop 固定使用此模式
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <PillButton
                  selected={runMode === 'new-session'}
                  onClick={() => setRunMode('new-session')}
                  disabled={disabled}
                >
                  新开对话
                </PillButton>
                <PillButton
                  selected={runMode === 'single-session'}
                  onClick={() => setRunMode('single-session')}
                  disabled={disabled}
                >
                  连续对话
                </PillButton>
              </div>
              <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                {runMode === 'new-session'
                  ? '每次执行创建新会话，无历史记忆，上下文干净'
                  : '所有轮次复用同一会话，AI 能记住之前内容'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
