// Query Navigator — floating right-side panel for quick session query navigation
// Collapsed: thin strip with dash indicators for each user query
// Expanded (on hover): text panel with truncated query previews, click to jump

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Message } from '../../types/chat';

/** Minimum user queries to show the navigator */
const MIN_QUERIES = 3;

interface QueryNavigatorProps {
  historyMessages: Message[];
  streamingMessage: Message | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  pauseAutoScroll: (duration?: number) => void;
}

/** Extract plain text preview from message content */
function getQueryText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const textBlock = msg.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    return textBlock?.text ?? '';
  }
  return '';
}

/** Check if a user message is a system injection (not real user query) */
function isSystemInjection(text: string): boolean {
  return (
    text.includes('<HEARTBEAT>') ||
    text.includes('<MEMORY_UPDATE>') ||
    text.startsWith('<system-reminder>')
  );
}

export default function QueryNavigator({
  historyMessages,
  streamingMessage,
  scrollContainerRef,
  pauseAutoScroll,
}: QueryNavigatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeIndexRaw, setActiveIndex] = useState(-1);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Extract real user queries (filter out system injections)
  const queries = useMemo(() => {
    const allMessages = streamingMessage
      ? [...historyMessages, streamingMessage]
      : historyMessages;

    return allMessages
      .filter((msg) => {
        if (msg.role !== 'user') return false;
        const text = getQueryText(msg);
        return text.trim() !== '' && !isSystemInjection(text);
      })
      .map((msg) => ({
        id: msg.id,
        text: getQueryText(msg),
      }));
  }, [historyMessages, streamingMessage]);

  // Clamp activeIndex to valid range (handles session switch, query list shrink)
  const activeIndex = activeIndexRaw >= 0 && activeIndexRaw < queries.length ? activeIndexRaw : -1;

  // Track active query via IntersectionObserver
  // Maintains a Set of all currently visible query indices (IO only reports changes,
  // not all visible elements), then derives the topmost visible as active.
  const visibleIndicesRef = useRef(new Set<number>());

  useEffect(() => {
    // Reset visible set on query list change (session switch, new messages)
    visibleIndicesRef.current.clear();

    if (queries.length < MIN_QUERIES) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const userElements = container.querySelectorAll<HTMLElement>('[data-role="user"]');
    if (userElements.length === 0) return;

    // Map message IDs to query indices for fast lookup
    const idToQueryIndex = new Map<string, number>();
    queries.forEach((q, i) => idToQueryIndex.set(q.id, i));

    const visibleSet = visibleIndicesRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        // Update the visible set based on intersection changes
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const messageId = el.getAttribute('data-message-id');
          if (!messageId) continue;
          const qIndex = idToQueryIndex.get(messageId);
          if (qIndex === undefined) continue;

          if (entry.isIntersecting) {
            visibleSet.add(qIndex);
          } else {
            visibleSet.delete(qIndex);
          }
        }

        // Active = smallest index in the visible set (topmost query)
        if (visibleSet.size > 0) {
          setActiveIndex(Math.min(...visibleSet));
        }
      },
      {
        root: container,
        rootMargin: '0px 0px -60% 0px', // Top 40% of viewport triggers
        threshold: 0,
      },
    );

    userElements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [queries, scrollContainerRef]);

  // Auto-scroll the expanded panel to keep active item visible
  useEffect(() => {
    if (isExpanded && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [isExpanded, activeIndex]);

  // Navigate to a query
  const handleQueryClick = useCallback(
    (queryId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(queryId)}"]`,
      );
      if (!target) return;

      pauseAutoScroll(2000); // Pause auto-scroll for 2s to let user view
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [scrollContainerRef, pauseAutoScroll],
  );

  // Don't render if fewer than MIN_QUERIES (after all hooks)
  if (queries.length < MIN_QUERIES) return null;

  return (
    <div
      className="absolute right-0 top-0 bottom-0 z-20 hidden md:flex items-center"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      {/* Collapsed: dash indicators */}
      <div
        className={`flex flex-col items-center justify-center gap-[5px] px-1.5 py-4 transition-opacity duration-200 ${
          isExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        {queries.map((q, i) => (
          <div
            key={q.id}
            className={`rounded-full transition-all duration-150 ${
              i === activeIndex
                ? 'w-[10px] h-[3px] bg-[var(--accent)]'
                : 'w-[8px] h-[2px] bg-[var(--ink-faint)]'
            }`}
          />
        ))}
      </div>

      {/* Expanded: text panel */}
      <div
        ref={panelRef}
        aria-hidden={!isExpanded}
        className={`absolute right-1 max-h-[60vh] w-52 overflow-hidden rounded-xl border border-[var(--line)] shadow-lg transition-[opacity,transform] duration-200 ${
          isExpanded
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
        style={{
          top: '50%',
          transform: `translateY(-50%) translateX(${isExpanded ? '0' : '8px'})`,
          background: 'var(--paper-elevated)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        {/* Top fade mask */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-[var(--paper-elevated)] to-transparent" />

        {/* Scrollable query list */}
        <div className="overflow-y-auto max-h-[60vh] py-5 px-1">
          {queries.map((q, i) => (
            <button
              key={q.id}
              ref={i === activeIndex ? activeItemRef : undefined}
              type="button"
              onClick={() => handleQueryClick(q.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                i === activeIndex
                  ? 'bg-[var(--hover-bg)]'
                  : 'hover:bg-[var(--hover-bg)]'
              }`}
            >
              {/* Query text */}
              <span
                className={`flex-1 truncate text-xs ${
                  i === activeIndex
                    ? 'text-[var(--accent)] font-medium'
                    : 'text-[var(--ink-muted)]'
                }`}
              >
                {q.text}
              </span>
              {/* Dash indicator */}
              <span
                className={`flex-shrink-0 rounded-full ${
                  i === activeIndex
                    ? 'w-[10px] h-[3px] bg-[var(--accent)]'
                    : 'w-[8px] h-[2px] bg-[var(--ink-faint)]'
                }`}
              />
            </button>
          ))}
        </div>

        {/* Bottom fade mask */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-[var(--paper-elevated)] to-transparent" />
      </div>
    </div>
  );
}
