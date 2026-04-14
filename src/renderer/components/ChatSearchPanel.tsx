/**
 * ChatSearchPanel — floating top-right in-page text finder for Chat.
 *
 * Scope: only already rendered messages. Virtualized items outside the DOM
 * are not searchable — the panel surfaces this limitation in its empty state
 * so users understand why a match may be missing.
 *
 * Interaction:
 *   • Enter = next match, Shift+Enter = previous
 *   • Esc closes
 *   • Cmd/Ctrl+F inside the input re-selects the text
 */

import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { ChatSearchController } from '@/hooks/useChatSearch';

interface ChatSearchPanelProps {
  controller: ChatSearchController;
  onClose: () => void;
}

export default function ChatSearchPanel({ controller, onClose }: ChatSearchPanelProps) {
  const { query, setQuery, matchCount, currentIndex, next, prev, hasQuery } = controller;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) prev();
      else next();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      inputRef.current?.select();
    }
  };

  const counterLabel = (() => {
    if (!hasQuery) return '';
    if (matchCount === 0) return '0 / 0';
    return `${currentIndex + 1} / ${matchCount}`;
  })();

  const showEmptyHint = hasQuery && matchCount === 0;

  return (
    <div
      className="absolute right-4 top-3 z-[100] flex flex-col gap-1 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md"
      style={{ minWidth: 320 }}
      role="search"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="在当前页面中查找"
          aria-label="在当前页面中查找"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--ink-muted)]">
          {counterLabel}
        </span>
        <div className="mx-0.5 h-4 w-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={prev}
          disabled={matchCount === 0}
          title="上一个 (Shift+Enter)"
          aria-label="上一个匹配"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={next}
          disabled={matchCount === 0}
          title="下一个 (Enter)"
          aria-label="下一个匹配"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭搜索"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {showEmptyHint && (
        <div className="border-t border-[var(--line-subtle)] px-3 py-1.5 text-[11px] leading-[1.5] text-[var(--ink-muted)]">
          仅在已渲染的消息中查找。较早的消息已被虚拟化，
          请滚动加载或使用启动页的全文搜索。
        </div>
      )}
    </div>
  );
}
