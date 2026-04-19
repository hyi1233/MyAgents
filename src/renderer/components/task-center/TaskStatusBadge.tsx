// TaskStatusBadge — compact colored label for a TaskStatus.
//
// Three-tier visual hierarchy per DESIGN.md §6.4 + §10.3:
//   - active   (running/verifying)  → info tint  (执行中 = --info per §10.3)
//   - terminal (done)                → success tint
//   - warning  (blocked)             → error tint
//   - idle     (stopped/archived)    → muted default
//   - latent   (todo)                → borderless, dot-led, lowest priority
//                                      so a list of 14 "待启动" tasks doesn't
//                                      visually compete with the few
//                                      running/blocked ones that actually
//                                      demand attention
// Verifying shares the info bucket with running — both are "actively
// engaged" states. Migrating from accent-warm (which §10.3 reserves for
// a different role) avoids stealing accent from the primary-button CTA.
//
// Used in TaskCard + TaskDetailOverlay.

import type { TaskStatus } from '@/../shared/types/task';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待启动',
  running: '进行中',
  verifying: '验证中',
  done: '已完成',
  blocked: '已阻塞',
  stopped: '已暂停',
  archived: '已归档',
  deleted: '已删除',
};

interface StatusStyle {
  bg: string;
  fg: string;
  dot?: string;
  /** When true, badge renders without bg/padding — dot + text only. */
  latent?: boolean;
}

const STATUS_STYLE: Record<TaskStatus, StatusStyle> = {
  // Latent — no bg, just a muted dot + label so a long 待启动 list reads
  // as "inventory" rather than a wall of colored chips.
  todo: {
    bg: '',
    fg: 'text-[var(--ink-muted)]',
    dot: 'bg-[var(--ink-subtle)]',
    latent: true,
  },
  // Active — info bucket.
  running: {
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
    dot: 'bg-[var(--info)]',
  },
  verifying: {
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
    dot: 'bg-[var(--info)]',
  },
  // Terminal OK — success bucket.
  done: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
    dot: 'bg-[var(--success)]',
  },
  // Needs attention — error bucket.
  blocked: {
    bg: 'bg-[var(--error-bg)]',
    fg: 'text-[var(--error)]',
    dot: 'bg-[var(--error)]',
  },
  // Idle — default muted.
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
  const padding = style.latent
    ? ''
    : compact
      ? 'px-1.5 py-0.5'
      : 'px-2 py-0.5';
  const radius = style.latent ? '' : 'rounded-[var(--radius-sm)]';
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium ${style.bg} ${style.fg} ${radius} ${padding} ${size}`}
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
