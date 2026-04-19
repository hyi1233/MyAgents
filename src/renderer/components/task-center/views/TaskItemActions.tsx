// TaskItemActions — single "…" overflow button that carries every action
// available on a task row (run / stop / rerun / open detail / delete).
// Shared by both the card and list views.
//
// Prior iteration had a separate primary-action button next to the "…" —
// that meant the per-status button changed shape under the user's cursor
// (▶ → ■ → ↻) and ate real estate at the card's top-right corner. The
// new shape folds everything into the menu so the card's top-right has a
// single, stable target (`…`) regardless of status.
//
// Legacy-cron rows reuse the same component; they surface only 打开详情
// and 删除 since their other lifecycle operations live in the separate
// LegacyCronOverlay.

import { useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react';

import { Popover } from '@/components/ui/Popover';
import type { Task, TaskStatus } from '@/../shared/types/task';

export interface TaskItemActionsProps {
  variant: 'task' | 'legacy';
  /** Live status — native task value, or derived for legacy. */
  status: TaskStatus;
  /** Busy flag locks all actions during a pending async op. */
  busy?: boolean;
  /** Fired by the primary action (▶ for todo, ■ for running, ↻ for rerun). */
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  /** Kept for legacy-variant menus which still surface "打开详情". For the
   *  `task` variant the card body itself handles opening the detail view
   *  (clicking the card area), so we don't duplicate the entry in the
   *  menu — the menu instead offers `onEdit` which lands directly on the
   *  editor. */
  onOpenDetail: () => void;
  /** Opens the detail overlay already in edit mode (task variant only). */
  onEdit?: () => void;
  onDelete?: () => void;
}

export function TaskItemActions({
  variant,
  status,
  busy,
  onRun,
  onStop,
  onRerun,
  onOpenDetail,
  onEdit,
  onDelete,
}: TaskItemActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const primary = variant === 'legacy'
    ? null
    : primaryActionFor(status, { onRun, onStop, onRerun });

  return (
    <div
      className="flex items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={menuBtnRef}
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        title="更多操作"
        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuBtnRef}
        placement="bottom-end"
        className="min-w-[140px] py-1"
      >
        {/* Menu ordering (v0.1.69):
              1. 编辑 (task variant) — clicking the card already opens the
                 detail view, so the menu skips 打开详情 and lands the user
                 directly on the editor instead.
              2. Primary lifecycle action — 立即执行 / 中止 / 重新派发,
                 depending on current status (see `primaryActionFor` below).
              3. 删除 — separated visually via `--error` tint.
            Legacy rows still need 打开详情 because their editor lives in
            LegacyCronOverlay, which is reached through the detail view. */}
        {variant === 'task' && onEdit && (
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
        )}
        {variant === 'legacy' && (
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onOpenDetail();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            打开详情
          </button>
        )}
        {primary && (
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              primary.handler?.();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${primary.menuClassName}`}
          >
            {primary.icon}
            {primary.title}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--error)] hover:bg-[var(--error-bg)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        )}
      </Popover>
    </div>
  );
}

interface PrimaryAction {
  icon: React.ReactNode;
  title: string;
  /** `<button>` class for the menu-item variant (full-width row). */
  menuClassName: string;
  handler: (() => void) | undefined;
}

function primaryActionFor(
  status: TaskStatus,
  handlers: Pick<TaskItemActionsProps, 'onRun' | 'onStop' | 'onRerun'>,
): PrimaryAction | null {
  switch (status) {
    case 'todo':
      return {
        icon: <Play className="h-3.5 w-3.5" />,
        title: '立即执行',
        menuClassName:
          'text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]',
        handler: handlers.onRun,
      };
    case 'running':
    case 'verifying':
      return {
        icon: <Square className="h-3.5 w-3.5" />,
        title: '中止',
        menuClassName:
          'text-[var(--ink-secondary)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]',
        handler: handlers.onStop,
      };
    case 'blocked':
    case 'stopped':
    case 'done':
      return {
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        title: '重新派发',
        menuClassName:
          'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]',
        handler: handlers.onRerun,
      };
    default:
      return null;
  }
}

/** Derive a TaskStatus-compatible value from a native Task or a legacy cron. */
export function deriveTaskRowStatus(task: Task | null, legacyRunning?: boolean): TaskStatus {
  if (task) return task.status;
  return legacyRunning ? 'running' : 'stopped';
}
