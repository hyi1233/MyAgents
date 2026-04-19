// TaskEditPanel — edit mode for a Task. Rendered inside `TaskDetailOverlay`
// when the user clicks the 「编辑」 affordance. Shares its scheduling and
// end-condition editors with the dispatch dialog so creation and subsequent
// edits stay pixel-aligned.
//
// All field mutations flow into a local `draft` state; the save handler diffs
// against the initial Task and sends only the changed fields through
// `cmd_task_update` (PRD §9.4 — schedule-shape changes also detach the
// backing CronTask, handled in Rust). Cancel discards the draft and rolls
// back to read-only view.

import { useCallback, useEffect, useMemo, useState } from 'react';

import CustomSelect from '@/components/CustomSelect';
import { taskReadDoc, taskUpdate } from '@/api/taskCenter';
import NotificationConfigEditor from '@/components/task-center/NotificationConfigEditor';
import type {
  EndConditions,
  NotificationConfig,
  Task,
  TaskExecutionMode,
  TaskRunMode,
  TaskUpdateInput,
} from '@/../shared/types/task';
import {
  EndConditionsEditor,
  type EndConditionMode,
} from './editors/EndConditionsEditor';
import { ExecutionModeEditor } from './editors/ExecutionModeEditor';
import { INPUT_CLS, toLocalDateTimeString } from './editors/controls';
import { extractErrorMessage } from './errors';

const PERMISSION_MODE_OPTIONS = [
  { value: 'auto', label: '自动 (Auto)' },
  { value: 'plan', label: '仅计划 (Plan)' },
  { value: 'fullAgency', label: '完全自治 (Full Agency)' },
];

export interface TaskEditPanelProps {
  task: Task;
  onSaved: (next: Task) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

interface Draft {
  name: string;
  description: string;
  tagsInput: string;
  taskMd: string;
  executionMode: TaskExecutionMode;
  runMode: TaskRunMode;
  atDateTime: string;
  intervalMinutes: number;
  cronExpression: string;
  cronTimezone: string;
  endConditionMode: EndConditionMode;
  deadline: string;
  maxExecutions: string;
  aiCanExit: boolean;
  notification: NotificationConfig;
  model: string;
  permissionMode: string;
}

function taskToDraft(task: Task, taskMd: string): Draft {
  // End-condition mode is derived: if any constraint is present, the user
  // intended "conditional"; otherwise "forever".
  const ec = task.endConditions;
  const hasConstraints = !!(ec?.deadline || ec?.maxExecutions);
  const endConditionMode: EndConditionMode = hasConstraints ? 'conditional' : 'forever';
  // `dispatchAt` is now the authoritative "when to fire" timestamp for
  // scheduled mode. Fall back to the legacy `endConditions.deadline` for
  // rows created before the split.
  const atSource = task.dispatchAt ?? (task.executionMode === 'scheduled' ? ec?.deadline : undefined);
  const atDateTime = atSource ? toLocalDateTimeString(new Date(atSource)) : '';
  return {
    name: task.name,
    description: task.description ?? '',
    tagsInput: task.tags.join(', '),
    taskMd,
    executionMode: task.executionMode,
    runMode: task.runMode ?? 'new-session',
    atDateTime,
    intervalMinutes: task.intervalMinutes ?? 30,
    cronExpression: task.cronExpression ?? '',
    cronTimezone: task.cronTimezone ?? '',
    endConditionMode,
    deadline: ec?.deadline ? toLocalDateTimeString(new Date(ec.deadline)) : '',
    maxExecutions: ec?.maxExecutions ? String(ec.maxExecutions) : '',
    aiCanExit: ec?.aiCanExit ?? true,
    notification: task.notification ?? { desktop: true },
    model: task.model ?? '',
    permissionMode: task.permissionMode ?? 'auto',
  };
}

export function TaskEditPanel({ task, onSaved, onCancel, onError }: TaskEditPanelProps) {
  const [draft, setDraft] = useState<Draft>(() => taskToDraft(task, ''));
  const [saving, setSaving] = useState(false);
  const [taskMdLoaded, setTaskMdLoaded] = useState(false);
  const isAiAligned = task.dispatchOrigin === 'ai-aligned';

  // Read the current task.md body once so the user can edit the prompt
  // in-place. AI-aligned tasks have no editable prompt here (their
  // alignment.md is the source of truth and a separate skill).
  useEffect(() => {
    let cancelled = false;
    if (isAiAligned) {
      setTaskMdLoaded(true);
      return;
    }
    void taskReadDoc(task.id, 'task')
      .then((content) => {
        if (cancelled) return;
        setDraft((d) => ({ ...d, taskMd: content }));
        setTaskMdLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setTaskMdLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, isAiAligned]);

  // If the task transitions to running / verifying while we're editing
  // (external SSE — scheduler fired, or another window changed status),
  // we'd be presenting editable controls the backend will reject. Bail
  // out of edit mode and surface why.
  const locked = task.status === 'running' || task.status === 'verifying';
  useEffect(() => {
    if (locked) {
      onError('任务已开始执行，编辑已取消（PRD §9.4）。');
      onCancel();
    }
  }, [locked, onCancel, onError]);

  const isScheduled = draft.executionMode === 'scheduled';
  const isRecurring = draft.executionMode === 'recurring';
  const isLoop = draft.executionMode === 'loop';
  const showEndConditions = isRecurring || isLoop;

  // Keep runMode aligned with PRD §9.2 defaults when user flips mode.
  const setExecutionMode = useCallback((next: TaskExecutionMode) => {
    setDraft((d) => {
      const nextRunMode: TaskRunMode =
        next === 'loop' ? 'single-session'
          : next === 'recurring' ? 'new-session'
            : d.runMode;
      return { ...d, executionMode: next, runMode: nextRunMode };
    });
  }, []);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!draft.name.trim()) errs.push('请填写任务名');
    if (!isAiAligned && !draft.taskMd.trim()) errs.push('task.md 内容不能为空');
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (Number.isNaN(ts) || ts <= Date.now()) errs.push('执行时间必须在未来');
    }
    if (isRecurring) {
      const advancedOn = draft.cronExpression.trim().length > 0;
      if (advancedOn) {
        // Rust nom-cron is strict; do a shallow shape check here to catch
        // the obvious "forgot a field" mistake before the backend would.
        if (draft.cronExpression.trim().split(/\s+/).length !== 5) {
          errs.push('Cron 表达式必须是 5 段(分 时 日 月 周)');
        }
      } else if (draft.intervalMinutes < 5) {
        errs.push('周期间隔不能小于 5 分钟');
      }
    }
    if (
      showEndConditions &&
      draft.endConditionMode === 'conditional' &&
      !draft.deadline &&
      !draft.maxExecutions &&
      !draft.aiCanExit
    ) {
      errs.push('请至少设置一个结束条件');
    }
    return errs;
  }, [draft, isScheduled, isRecurring, showEndConditions, isAiAligned]);

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (!showEndConditions) return undefined;
    if (draft.endConditionMode === 'forever') return { aiCanExit: draft.aiCanExit };
    const out: EndConditions = { aiCanExit: draft.aiCanExit };
    if (draft.deadline) {
      const ts = Date.parse(draft.deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    if (draft.maxExecutions) {
      const n = parseInt(draft.maxExecutions, 10);
      if (!Number.isNaN(n) && n > 0) out.maxExecutions = n;
    }
    return out;
  }, [draft, showEndConditions]);

  const handleSave = useCallback(async () => {
    if (errors.length > 0 || saving) return;
    const tags = draft.tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Build a partial update. `Option<T>` on the Rust side means "don't
    // touch this field" for any key we omit — so we send only what the
    // user actually changed. Rust's `update()` takes care of clearing
    // mode-incompatible fields when `executionMode` flips (PRD §9.4
    // hygiene), so we just forward the draft.
    const payload: TaskUpdateInput = { id: task.id };
    if (draft.name.trim() !== task.name) payload.name = draft.name.trim();
    if (draft.description.trim() !== (task.description ?? ''))
      payload.description = draft.description.trim();
    const initialTags = task.tags.join(',');
    if (tags.join(',') !== initialTags) payload.tags = tags;

    if (!isAiAligned && draft.taskMd !== '') {
      // Only send when we successfully loaded the original so we don't
      // stomp with an empty string.
      payload.prompt = draft.taskMd;
    }

    const modeChanged = draft.executionMode !== task.executionMode;
    if (modeChanged) payload.executionMode = draft.executionMode;

    if (draft.executionMode !== 'once') {
      const nextRunMode: TaskRunMode = isLoop ? 'single-session' : draft.runMode;
      if (modeChanged || nextRunMode !== task.runMode) payload.runMode = nextRunMode;

      const ec = buildEndConditions();
      const initialEc = JSON.stringify(task.endConditions ?? null);
      const nextEc = JSON.stringify(ec ?? null);
      if (modeChanged || initialEc !== nextEc) payload.endConditions = ec;
    }

    // Scheduling detail — only forward the field relevant to the target
    // mode so the Rust layer's mode-hygiene cleanup can do its job.
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (!Number.isNaN(ts) && ts !== task.dispatchAt) {
        payload.dispatchAt = ts;
      }
    } else if (isRecurring) {
      const advanced = draft.cronExpression.trim();
      if (advanced) {
        if (advanced !== (task.cronExpression ?? '')) payload.cronExpression = advanced;
        if (draft.cronTimezone !== (task.cronTimezone ?? ''))
          payload.cronTimezone = draft.cronTimezone;
      } else {
        // Simple mode — clear any cron expression the task had before.
        if (task.cronExpression) payload.cronExpression = '';
        if (task.cronTimezone) payload.cronTimezone = '';
        if (draft.intervalMinutes !== (task.intervalMinutes ?? 0)) {
          payload.intervalMinutes = draft.intervalMinutes;
        }
      }
    }

    // Execution overrides.
    if (draft.model !== (task.model ?? '')) payload.model = draft.model;
    if (draft.permissionMode !== (task.permissionMode ?? 'auto'))
      payload.permissionMode = draft.permissionMode;

    const initialNotification = JSON.stringify(task.notification ?? null);
    const nextNotification = JSON.stringify(draft.notification);
    if (initialNotification !== nextNotification)
      payload.notification = draft.notification;

    // Bail if nothing changed — stay in edit mode so the user isn't
    // thrown back to read-only with no feedback.
    if (Object.keys(payload).length === 1) {
      onError('没有需要保存的变更');
      return;
    }

    setSaving(true);
    try {
      const updated = await taskUpdate(payload);
      onSaved(updated);
    } catch (e) {
      onError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    draft,
    errors,
    saving,
    task,
    buildEndConditions,
    isScheduled,
    isRecurring,
    isLoop,
    isAiAligned,
    onSaved,
    onError,
  ]);

  return (
    <div className="space-y-5">
      {/* 基本信息 */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          基本信息
        </h3>
        <div className="space-y-3 pl-1">
          <Field label="任务名称" required>
            <input
              type="text"
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className={INPUT_CLS}
            />
          </Field>
          <Field label="简短描述" hint="可选">
            <input
              type="text"
              value={draft.description}
              maxLength={200}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="一行话说明，任务卡会展示"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="标签" hint="逗号分隔">
            <input
              type="text"
              value={draft.tagsInput}
              onChange={(e) => setDraft((d) => ({ ...d, tagsInput: e.target.value }))}
              placeholder="例如: news, weekly"
              className={INPUT_CLS}
            />
          </Field>
        </div>
      </section>

      {!isAiAligned && (
        <>
          <div className="border-t border-[var(--line-subtle)]" />
          <section>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              task.md 内容
            </h3>
            <div className="pl-1">
              <textarea
                value={draft.taskMd}
                onChange={(e) => setDraft((d) => ({ ...d, taskMd: e.target.value }))}
                rows={8}
                disabled={!taskMdLoaded}
                placeholder={taskMdLoaded ? '描述任务目标、约束、上下文' : '加载中…'}
                className={`${INPUT_CLS} resize-y font-mono text-[12.5px]`}
              />
              <p className="mt-2 text-[12px] text-[var(--ink-muted)]">
                AI 执行时看到的 prompt。保存时会原子写入 .task/&lt;id&gt;/task.md。
              </p>
            </div>
          </section>
        </>
      )}

      <div className="border-t border-[var(--line-subtle)]" />

      {/* 执行模式 */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          执行模式
        </h3>
        <div className="pl-1">
          <ExecutionModeEditor
            executionMode={draft.executionMode}
            setExecutionMode={setExecutionMode}
            runMode={draft.runMode}
            setRunMode={(v) => setDraft((d) => ({ ...d, runMode: v }))}
            atDateTime={draft.atDateTime}
            setAtDateTime={(v) => setDraft((d) => ({ ...d, atDateTime: v }))}
            intervalMinutes={draft.intervalMinutes}
            setIntervalMinutes={(v) => setDraft((d) => ({ ...d, intervalMinutes: v }))}
            cronExpression={draft.cronExpression}
            setCronExpression={(v) => setDraft((d) => ({ ...d, cronExpression: v }))}
            cronTimezone={draft.cronTimezone}
            setCronTimezone={(v) => setDraft((d) => ({ ...d, cronTimezone: v }))}
          />
        </div>
      </section>

      {showEndConditions && (
        <>
          <div className="border-t border-[var(--line-subtle)]" />
          <section>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              结束条件
            </h3>
            <div className="pl-1">
              <EndConditionsEditor
                mode={draft.endConditionMode}
                setMode={(v) => setDraft((d) => ({ ...d, endConditionMode: v }))}
                deadline={draft.deadline}
                setDeadline={(v) => setDraft((d) => ({ ...d, deadline: v }))}
                maxExecutions={draft.maxExecutions}
                setMaxExecutions={(v) => setDraft((d) => ({ ...d, maxExecutions: v }))}
                aiCanExit={draft.aiCanExit}
                setAiCanExit={(v) => setDraft((d) => ({ ...d, aiCanExit: v }))}
              />
            </div>
          </section>
        </>
      )}

      <div className="border-t border-[var(--line-subtle)]" />

      {/* 执行覆盖 */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          执行覆盖
          <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-[var(--ink-muted)]/70">
            留空则使用 Agent 默认值
          </span>
        </h3>
        <div className="space-y-3 pl-1">
          <Field label="模型" hint="覆盖 Agent 默认模型">
            <input
              type="text"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder="例如: claude-opus-4-7、deepseek-chat。留空使用 Agent 默认"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="权限模式">
            <CustomSelect
              value={draft.permissionMode || 'auto'}
              options={PERMISSION_MODE_OPTIONS}
              onChange={(v) => setDraft((d) => ({ ...d, permissionMode: v }))}
            />
          </Field>
        </div>
      </section>

      <div className="border-t border-[var(--line-subtle)]" />

      {/* 通知 */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          通知
        </h3>
        <div className="pl-1">
          <NotificationConfigEditor
            value={draft.notification}
            onChange={(v) => setDraft((d) => ({ ...d, notification: v }))}
          />
        </div>
      </section>

      {errors.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-[12px] text-[var(--error)]">
          {errors[0]}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || errors.length > 0}
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">
        {label}
        {hint && <span className="ml-2 text-[11px] text-[var(--ink-muted)]/70">{hint}</span>}
        {required && <span className="ml-1 text-[var(--accent-warm)]">*</span>}
      </label>
      {children}
    </div>
  );
}


