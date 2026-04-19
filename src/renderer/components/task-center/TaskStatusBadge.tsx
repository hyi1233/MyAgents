// TaskStatusBadge — status chip for the top-right of a task card.
//
// Rewired to match the v0.1.69 mockup:
//   - running          → info (blue)       — 执行中
//   - verifying        → accent-warm       — 验收中 (orange, matches the
//                                            mockup's "verifying" chip —
//                                            not info, because verifying
//                                            is AI self-checking, which
//                                            is conceptually closer to a
//                                            warm "attention" state than
//                                            the cool "working" state)
//   - done             → success (green)
//   - blocked          → warning (yellow)  — 已阻塞 (NOT error-red; the
//                                            mockup uses warning for
//                                            blocked because it's
//                                            "stuck, needs you" not "failed")
//   - stopped/archived → muted default
//   - todo             → muted default     — no latent-styling trick;
//                                            the left category chip
//                                            already carries the mode
//                                            distinction so todo cards
//                                            don't need an extra visual
//                                            downgrade
//
// Category (loop/once/scheduled/recurring) lives in <TaskCategoryBadge>
// on the top-left. Status (this component) and category are now two
// independent visual dimensions: left = "what kind of task", right =
// "where is it in its lifecycle".

import type { TaskStatus } from '@/../shared/types/task';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待启动',
  running: '进行中',
  verifying: '验收中',
  done: '已完成',
  blocked: '已阻塞',
  stopped: '已暂停',
  archived: '已归档',
  deleted: '已删除',
};

interface StatusStyle {
  bg: string;
  fg: string;
  /** Optional leading dot — used on "active" states to nudge scanning. */
  dot?: string;
}

const STATUS_STYLE: Record<TaskStatus, StatusStyle> = {
  todo: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-muted)]' },
  running: {
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
    dot: 'bg-[var(--info)]',
  },
  verifying: {
    bg: 'bg-[var(--accent-warm-subtle)]',
    fg: 'text-[var(--accent-warm)]',
    dot: 'bg-[var(--accent-warm)]',
  },
  done: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
  },
  blocked: {
    bg: 'bg-[var(--warning-bg)]',
    fg: 'text-[var(--warning)]',
  },
  stopped: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  archived: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  // Pseudo-state (soft-deleted) — only surfaces in audit views.
  deleted: { bg: 'bg-[var(--error-bg)]', fg: 'text-[var(--error)]' },
};

interface Props {
  status: TaskStatus;
  compact?: boolean;
}

export function TaskStatusBadge({ status, compact }: Props) {
  const style = STATUS_STYLE[status];
  const label = STATUS_LABEL[status];
  const size = compact ? 'text-[10px]' : 'text-[11px]';
  const padding = compact ? 'px-1.5 py-0.5' : 'px-2 py-0.5';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] font-medium ${style.bg} ${style.fg} ${padding} ${size}`}
    >
      {style.dot && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

export default TaskStatusBadge;
