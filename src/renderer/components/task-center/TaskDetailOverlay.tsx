// TaskDetailOverlay — modal covering Task Center with full details of one Task.
// PRD §7.3. Uses the shared OverlayBackdrop + closeLayer Cmd+W integration.

import { useCallback, useEffect, useState } from 'react';
import { X, Play, Archive, Trash2, Square, RotateCcw, CheckCircle, Pencil } from 'lucide-react';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
  taskArchive,
  taskDelete,
  taskGet,
  taskRerun,
  taskRun,
  taskUpdate,
  taskUpdateStatus,
} from '@/api/taskCenter';
import type { NotificationConfig, Task } from '@/../shared/types/task';
import { TaskStatusBadge } from './TaskStatusBadge';
import { DispatchOriginBadge } from './DispatchOriginBadge';
import { StatusHistoryList } from './StatusHistoryList';
import NotificationConfigEditor from './NotificationConfigEditor';
import { TaskDocBlock } from './TaskDocBlock';
import { TaskEditPanel } from './TaskEditPanel';

const OVERLAY_Z = 200;

interface Props {
  task: Task;
  onClose: () => void;
  onChanged?: (next: Task | null) => void;
}

export function TaskDetailOverlay({ task: initial, onClose, onChanged }: Props) {
  const [task, setTask] = useState<Task>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Bumped on every external task change so child blocks (TaskDocBlock) can
  // reload their document contents without us having to lift the content up.
  const [reloadToken, setReloadToken] = useState(0);

  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  // Refetch on mount so we show the latest statusHistory (in case UI was out of sync).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await taskGet(task.id);
        if (!cancelled && fresh) setTask(fresh);
      } catch {
        /* silent — use `initial` */
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- we only want this on mount
  }, []);

  // Live-update on external transitions (CLI / scheduler / other window).
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      const unlisten = await listen<{ taskId?: string }>(
        'task:status-changed',
        async (evt) => {
          if (evt.payload?.taskId !== task.id) return;
          try {
            const fresh = await taskGet(task.id);
            if (fresh) {
              setTask(fresh);
              setReloadToken((n) => n + 1);
            }
          } catch {
            /* silent */
          }
        },
      );
      if (cancelled) {
        unlisten();
      } else {
        off = unlisten;
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [task.id]);

  const runStatus = useCallback(
    async (next: Task['status']) => {
      setBusy(true);
      setErr(null);
      try {
        const updated = await taskUpdateStatus({ id: task.id, status: next });
        setTask(updated);
        onChanged?.(updated);
      } catch (e) {
        setErr(extractErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [task.id, onChanged],
  );

  const dispatchRun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRun(task.id);
      // The Rust endpoint transitions us to `running` via update_status; our
      // SSE listener upstairs handles the refresh, but also refetch here so
      // the overlay updates instantly.
      const fresh = await taskGet(task.id);
      if (fresh) {
        setTask(fresh);
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const dispatchRerun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRerun(task.id);
      const fresh = await taskGet(task.id);
      if (fresh) {
        setTask(fresh);
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const doArchive = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const updated = await taskArchive(task.id);
      setTask(updated);
      onChanged?.(updated);
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const doDelete = useCallback(async () => {
    if (!window.confirm('确定删除此任务？软删除后 30 天内可恢复。')) return;
    setBusy(true);
    setErr(null);
    try {
      await taskDelete(task.id);
      onChanged?.(null);
      onClose();
    } catch (e) {
      setErr(extractErrorMessage(e));
      setBusy(false);
    }
  }, [task.id, onChanged, onClose]);

  const locked = task.status === 'running' || task.status === 'verifying';

  const enterEdit = useCallback(() => {
    if (locked) return;
    setErr(null);
    setEditing(true);
  }, [locked]);

  const onEditSaved = useCallback(
    (next: Task) => {
      setTask(next);
      onChanged?.(next);
      setEditing(false);
      // Docs don't move here, but bump so dependent blocks re-render cleanly.
      setReloadToken((n) => n + 1);
    },
    [onChanged],
  );

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[min(780px,92vw)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <TaskStatusBadge status={task.status} />
              <DispatchOriginBadge origin={task.dispatchOrigin} />
            </div>
            <h2 className="mt-1.5 text-[18px] font-semibold text-[var(--ink)]">
              {task.name}
            </h2>
            {task.description && (
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                {task.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="关闭 (Cmd+W)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Action bar — hidden in edit mode (the edit panel has its own footer) */}
        {!editing && (
          <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-5 py-3">
            {task.status === 'todo' && (
              <ActionBtn
                icon={<Play className="h-3.5 w-3.5" />}
                label="立即执行"
                disabled={busy}
                onClick={dispatchRun}
              />
            )}
            {(task.status === 'running' || task.status === 'verifying') && (
              <ActionBtn
                icon={<Square className="h-3.5 w-3.5" />}
                label="中止"
                variant="danger"
                disabled={busy}
                onClick={() => runStatus('stopped')}
              />
            )}
            {(task.status === 'blocked' ||
              task.status === 'stopped' ||
              task.status === 'done' ||
              task.status === 'archived') && (
              <ActionBtn
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                label="重新派发"
                disabled={busy}
                onClick={dispatchRerun}
                title="reset → todo → run (PRD §10.2.2)"
              />
            )}
            {task.status === 'verifying' && (
              <ActionBtn
                icon={<CheckCircle className="h-3.5 w-3.5" />}
                label="标记完成"
                disabled={busy}
                onClick={() => runStatus('done')}
              />
            )}
            {task.status === 'done' && (
              <ActionBtn
                icon={<Archive className="h-3.5 w-3.5" />}
                label="归档"
                disabled={busy}
                onClick={doArchive}
              />
            )}
            <ActionBtn
              icon={<Pencil className="h-3.5 w-3.5" />}
              label="编辑"
              disabled={busy || locked}
              onClick={enterEdit}
              title={locked ? '任务运行 / 验证中，不可编辑（PRD §9.4）' : undefined}
            />
            <div className="flex-1" />
            <ActionBtn
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="删除"
              variant="danger"
              disabled={busy}
              onClick={doDelete}
            />
          </div>
        )}

        {err && (
          <div className="border-b border-[var(--error)]/30 bg-[var(--error-bg)] px-5 py-2 text-[12px] text-[var(--error)]">
            {err}
          </div>
        )}

        {/* Body: scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <TaskEditPanel
              task={task}
              onSaved={onEditSaved}
              onCancel={() => setEditing(false)}
              onError={setErr}
            />
          ) : (
            <>
              <Meta task={task} />

              <hr className="my-4 border-[var(--line-subtle)]" />

              {/* task.md — the executor prompt; editable via TaskDocBlock. */}
              <TaskDocBlock
                task={task}
                doc="task"
                title="task.md · 执行 Prompt"
                emptyHint="还没有内容。点击「添加」写入这个任务的执行提示词。"
                readOnly={locked}
                reloadKey={reloadToken}
                onError={setErr}
              />

              {/* verify.md — acceptance criteria; same component handles empty state. */}
              <TaskDocBlock
                task={task}
                doc="verify"
                title="verify.md · 验收标准"
                emptyHint="还没有验收标准。点击「添加」写一份；AI 在 verifying 阶段会用它自检。"
                readOnly={locked}
                reloadKey={reloadToken}
                onError={setErr}
              />

              {/* progress.md — read-only; agents append during runs. */}
              <TaskDocBlock
                task={task}
                doc="progress"
                title="progress.md · 执行日志"
                emptyHint="还没有执行记录。AI 在执行过程中会将阶段性进度追加到此处。"
                readOnly
                reloadKey={reloadToken}
                onError={setErr}
              />

              <hr className="my-4 border-[var(--line-subtle)]" />

              <StatusHistoryList task={task} />

              <hr className="my-4 border-[var(--line-subtle)]" />

              <NotificationSection
                task={task}
                disabled={locked}
                onSaved={(updated) => {
                  setTask(updated);
                  onChanged?.(updated);
                }}
                onError={(msg) => setErr(msg)}
              />
            </>
          )}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function Meta({ task }: { task: Task }) {
  const rows: Array<[string, string]> = [
    ['创建', new Date(task.createdAt).toLocaleString()],
    ['更新', new Date(task.updatedAt).toLocaleString()],
    [
      '上次执行',
      task.lastExecutedAt
        ? new Date(task.lastExecutedAt).toLocaleString()
        : '—',
    ],
    ['执行者', task.executor === 'agent' ? 'Agent' : '用户'],
    ['执行模式', task.executionMode],
    [
      '工作区',
      task.workspacePath ?? task.workspaceId,
    ],
    ['Runtime', task.runtime ?? 'builtin'],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--ink-muted)]/70">{k}</dt>
          <dd className="truncate text-[var(--ink)]">{v}</dd>
        </div>
      ))}
      {task.tags.length > 0 && (
        <div className="contents">
          <dt className="text-[var(--ink-muted)]/70">标签</dt>
          <dd className="flex flex-wrap gap-1">
            {task.tags.map((t) => (
              <span
                key={t}
                className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)]"
              >
                #{t}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: 'default' | 'danger';
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
  variant,
}: ActionBtnProps) {
  const base =
    'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const variantCls =
    variant === 'danger'
      ? 'text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]'
      : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variantCls}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Notification config with local draft + explicit save. Avoids per-keystroke
 * Rust writes (CC review W5) and fully disables editing while the task is
 * running (W4 — the Rust `update()` guard would reject anyway, so we surface
 * the constraint in the UI instead of letting users bump against invisible
 * walls).
 */
function NotificationSection({
  task,
  disabled,
  onSaved,
  onError,
}: {
  task: Task;
  disabled: boolean;
  onSaved: (updated: Task) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<NotificationConfig>(
    task.notification ?? { desktop: true },
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // If parent task updates (e.g. SSE-driven refetch), reset draft to match.
  useEffect(() => {
    setDraft(task.notification ?? { desktop: true });
    setDirty(false);
  }, [task]);

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const updated = await taskUpdate({ id: task.id, notification: draft });
      onSaved(updated);
      setDirty(false);
    } catch (e) {
      onError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, task.id, onSaved, onError]);

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          通知
        </div>
        {dirty && !disabled && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-[var(--radius-md)] bg-[var(--accent-warm-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)] disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>
      {disabled && (
        <div className="mb-1.5 text-[11px] text-[var(--ink-muted)]/70">
          任务运行 / 验证中，通知设置不可编辑
        </div>
      )}
      <div
        className={
          disabled ? 'pointer-events-none opacity-50' : undefined
        }
      >
        <NotificationConfigEditor
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setDirty(true);
          }}
        />
      </div>
    </div>
  );
}

function extractErrorMessage(e: unknown): string {
  const s = String(e);
  // Rust layer serializes TaskOpError as JSON-stringified `{code, message}`.
  try {
    const parsed = JSON.parse(s) as { code?: string; message?: string };
    if (parsed && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return s;
}

export default TaskDetailOverlay;
