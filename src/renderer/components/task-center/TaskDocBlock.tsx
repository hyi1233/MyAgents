// TaskDocBlock — render + edit one of a task's markdown documents
// (`task.md` or `verify.md`). Swaps between a read-only Markdown preview
// and a Monaco editor. Writes go through `cmd_task_write_doc`; the Rust
// layer enforces the running/verifying lock (PRD §9.4).
//
// `progress.md` is NOT editable here — the CLI / SDK tool appends to it
// during runs. We render it read-only through this same block (caller
// passes `readOnly`) so the three-document layout stays consistent.

import { useCallback, useEffect, useState } from 'react';
import { Pencil, X } from 'lucide-react';

import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import { taskReadDoc, taskWriteDoc, type TaskDocName } from '@/api/taskCenter';
import type { Task } from '@/../shared/types/task';

interface Props {
  task: Task;
  /** Which document — the API treats `progress` as read-only (agent writes). */
  doc: TaskDocName;
  title: string;
  /** Surfaced when the file is missing; e.g. "尚未填写验收标准". */
  emptyHint: string;
  /** Disable editing entirely (e.g. progress.md, or running/verifying task). */
  readOnly?: boolean;
  /** Signal: task refetched externally → reload content. */
  reloadKey?: unknown;
  onError: (msg: string) => void;
}

export function TaskDocBlock({
  task,
  doc,
  title,
  emptyHint,
  readOnly = false,
  reloadKey,
  onError,
}: Props) {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // (Re)load on task id change or external refetch. `editing` resets when
  // the underlying task changes out from under us.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setEditing(false);
    void (async () => {
      try {
        const body = await taskReadDoc(task.id, doc);
        if (cancelled) return;
        setContent(body);
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        onError(extractErrorMessage(e));
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, doc, reloadKey, onError]);

  const startEdit = useCallback(() => {
    setDraft(content);
    setEditing(true);
  }, [content]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  const handleSave = useCallback(async () => {
    if (doc === 'progress') return; // defensive — shouldn't reach here
    setSaving(true);
    try {
      await taskWriteDoc(task.id, doc, draft);
      setContent(draft);
      setEditing(false);
    } catch (e) {
      onError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [task.id, doc, draft, onError]);

  // Cmd/Ctrl+S inside Monaco saves and exits edit mode.
  const onMonacoSave = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          {title}
        </h3>
        {!readOnly && loaded && !editing && (
          <button
            type="button"
            onClick={startEdit}
            title={content ? '编辑' : '添加'}
            className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <Pencil className="h-3 w-3" />
            {content ? '编辑' : '添加'}
          </button>
        )}
      </div>

      {!loaded ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)] p-3 text-[12px] text-[var(--ink-muted)]">
          加载中…
        </div>
      ) : editing ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)]">
          <MonacoEditor
            value={draft}
            onChange={setDraft}
            language="markdown"
            onSave={onMonacoSave}
            autoFocus
            className="min-h-[200px]"
          />
          <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-3 py-2">
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存 (⌘S)'}
            </button>
          </div>
        </div>
      ) : content ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)] p-4">
          <Markdown>{content}</Markdown>
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--line)] bg-[var(--paper)] p-3 text-[12px] text-[var(--ink-muted)]">
          {emptyHint}
        </div>
      )}
    </section>
  );
}

function extractErrorMessage(e: unknown): string {
  const s = String(e);
  try {
    const parsed = JSON.parse(s) as { code?: string; message?: string };
    if (parsed && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return s;
}

export default TaskDocBlock;
