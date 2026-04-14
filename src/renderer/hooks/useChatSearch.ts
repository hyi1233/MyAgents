/**
 * useChatSearch — in-page text finder for the Chat message list.
 *
 * Uses the CSS Custom Highlight API (CSS.highlights) instead of mutating the
 * DOM with <mark> tags. Virtuoso virtualizes + streaming constantly reconciles,
 * so any injected nodes would be wiped. Highlight API paints via Range objects
 * without touching the DOM tree.
 *
 * Rescans are driven by three sources: query change (debounced), scroller
 * scroll (Virtuoso unmounts items off-screen), and MutationObserver (streaming
 * appends / edits / rewinds). Without the latter two, stored Range objects
 * would go stale as soon as the user scrolls or the AI emits more content.
 *
 * Scope: only text nodes inside elements marked with `[data-chat-search-scope]`
 * (currently each message wrapper in MessageList). This excludes status
 * timers, permission prompts, and split panels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── CSS Highlight API types (not yet in lib.dom for all TS versions) ──
interface HighlightLike {
  clear: () => void;
  add: (range: Range) => void;
  size: number;
}
interface HighlightRegistryLike {
  set: (name: string, highlight: HighlightLike) => void;
  delete: (name: string) => void;
}
interface CssWithHighlights {
  highlights?: HighlightRegistryLike;
  Highlight?: new (...ranges: Range[]) => HighlightLike;
}

const HIGHLIGHT_ALL = 'chat-search';
const HIGHLIGHT_CURRENT = 'chat-search-current';
const SCOPE_ATTR = 'data-chat-search-scope';
const DEBOUNCE_MS = 150;

function getCssHighlights(): CssWithHighlights | null {
  if (typeof CSS === 'undefined') return null;
  return CSS as unknown as CssWithHighlights;
}

export function isHighlightApiSupported(): boolean {
  const css = getCssHighlights();
  return !!(css && css.highlights && css.Highlight);
}

/**
 * Walk text nodes inside every `[data-chat-search-scope]` subtree under `root`.
 * Using a per-scope walker (instead of one big walker with an acceptNode
 * ancestor check) avoids an O(depth) walk per text node.
 */
function collectTextNodes(root: HTMLElement): Text[] {
  const scopes = root.querySelectorAll<HTMLElement>(`[${SCOPE_ATTR}]`);
  const nodes: Text[] = [];
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent) {
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let current = walker.nextNode();
    while (current) {
      nodes.push(current as Text);
      current = walker.nextNode();
    }
  }
  return nodes;
}

/** Build Range objects for every case-insensitive match of `query` in `nodes`. */
function buildRanges(nodes: Text[], query: string): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  const needleLen = needle.length;
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text) continue;
    const hay = text.toLowerCase();
    let from = 0;
    while (from <= hay.length - needleLen) {
      const idx = hay.indexOf(needle, from);
      if (idx === -1) break;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needleLen);
      ranges.push(range);
      from = idx + needleLen;
    }
  }
  return ranges;
}

/**
 * Walk ancestors from `start` up to `stop` (exclusive) and clear inline
 * maxHeight / overflow clipping so a highlighted match inside a collapsed
 * container becomes visible. React owns these inline styles, so any later
 * re-render of the owning component will restore them — that's fine.
 */
function uncollapseAncestors(start: Element | null, stop: Element | null): void {
  let el: Element | null = start;
  while (el && el !== stop) {
    if (el instanceof HTMLElement) {
      if (el.style.maxHeight) el.style.maxHeight = 'none';
      if (el.style.overflow === 'hidden') el.style.overflow = 'visible';
    }
    el = el.parentElement;
  }
}

/** Scroll `scroller` so the center of `range` lands at the scroller's vertical center. */
function scrollRangeIntoView(scroller: HTMLElement, range: Range): void {
  // Ensure the range's container is still attached — otherwise getBoundingClientRect
  // returns an all-zero rect and we'd scroll to the top.
  const container = range.startContainer;
  if (!container.isConnected) return;
  const rangeRect = range.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  if (rangeRect.height === 0 && rangeRect.width === 0) {
    // Degenerate (empty/collapsed) rect — fall back to parent element.
    const parent = container.parentElement;
    if (parent) parent.scrollIntoView({ block: 'center' });
    return;
  }
  const rangeCenter = rangeRect.top + rangeRect.height / 2;
  const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
  const delta = rangeCenter - scrollerCenter;
  scroller.scrollBy({ top: delta });
}

export interface UseChatSearchOptions {
  scrollerRef: React.RefObject<HTMLElement | null>;
  /** When true, the hook is active: scan + paint highlights. */
  active: boolean;
}

export interface ChatSearchController {
  query: string;
  setQuery: (value: string) => void;
  matchCount: number;
  currentIndex: number; // 0-based; -1 when no matches
  next: () => void;
  prev: () => void;
  /** True if the Highlight API is available in this environment. */
  supported: boolean;
  /** True while a scan is pending (debounced or in-flight). */
  hasQuery: boolean;
}

export function useChatSearch({ scrollerRef, active }: UseChatSearchOptions): ChatSearchController {
  const [query, setQueryState] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const rangesRef = useRef<Range[]>([]);
  // Mirror of currentIndex so next/prev can read the latest value synchronously
  // without closing over stale state and without embedding side effects inside
  // a setState updater (which would double-fire in StrictMode).
  const currentIndexRef = useRef(-1);
  const queryRef = useRef('');
  queryRef.current = query;

  const supported = useMemo(isHighlightApiSupported, []);

  const clearHighlights = useCallback(() => {
    const css = getCssHighlights();
    if (!css?.highlights) return;
    css.highlights.delete(HIGHLIGHT_ALL);
    css.highlights.delete(HIGHLIGHT_CURRENT);
  }, []);

  const paintHighlights = useCallback(
    (ranges: Range[], focusedIdx: number) => {
      const css = getCssHighlights();
      if (!css?.highlights || !css.Highlight) return;
      css.highlights.delete(HIGHLIGHT_ALL);
      css.highlights.delete(HIGHLIGHT_CURRENT);
      if (ranges.length === 0) return;
      const others: Range[] = [];
      for (let i = 0; i < ranges.length; i += 1) {
        if (i !== focusedIdx) others.push(ranges[i]);
      }
      if (others.length > 0) {
        css.highlights.set(HIGHLIGHT_ALL, new css.Highlight(...others));
      }
      if (focusedIdx >= 0 && focusedIdx < ranges.length) {
        css.highlights.set(HIGHLIGHT_CURRENT, new css.Highlight(ranges[focusedIdx]));
      }
    },
    [],
  );

  const focusRange = useCallback(
    (idx: number) => {
      const ranges = rangesRef.current;
      if (idx < 0 || idx >= ranges.length) return;
      const range = ranges[idx];
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const parent = range.startContainer.parentElement;
      if (parent) uncollapseAncestors(parent, scroller);
      scrollRangeIntoView(scroller, range);
    },
    [scrollerRef],
  );

  // ── Core scan — recomputes ranges from current query + DOM state ──
  // `preserveFocus`: when triggered by scroll / MutationObserver, keep the
  // user's current match position if still valid; when triggered by query
  // change, reset to 0.
  const runScan = useCallback(
    (preserveFocus: boolean) => {
      if (!active || !supported) {
        rangesRef.current = [];
        currentIndexRef.current = -1;
        setMatchCount(0);
        setCurrentIndex(-1);
        clearHighlights();
        return;
      }
      const scroller = scrollerRef.current;
      const q = queryRef.current;
      if (!scroller || !q) {
        rangesRef.current = [];
        currentIndexRef.current = -1;
        setMatchCount(0);
        setCurrentIndex(-1);
        clearHighlights();
        return;
      }
      const textNodes = collectTextNodes(scroller);
      const ranges = buildRanges(textNodes, q);
      rangesRef.current = ranges;

      let nextIdx: number;
      if (ranges.length === 0) {
        nextIdx = -1;
      } else if (preserveFocus) {
        const prior = currentIndexRef.current;
        nextIdx = prior >= 0 && prior < ranges.length ? prior : 0;
      } else {
        nextIdx = 0;
      }
      currentIndexRef.current = nextIdx;
      setMatchCount(ranges.length);
      setCurrentIndex(nextIdx);
      paintHighlights(ranges, nextIdx);
      if (nextIdx >= 0 && !preserveFocus) focusRange(nextIdx);
    },
    [active, supported, scrollerRef, clearHighlights, paintHighlights, focusRange],
  );

  // ── Debounced scheduler for query changes and DOM mutations ──
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRescan = useCallback(
    (preserveFocus: boolean) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        runScan(preserveFocus);
      }, DEBOUNCE_MS);
    },
    [runScan],
  );

  // Rescan on query change (reset focus to first match).
  useEffect(() => {
    if (!active) return;
    scheduleRescan(false);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [active, query, scheduleRescan]);

  // Observe scroller scroll + DOM mutations so Virtuoso virtualization and
  // streaming content updates don't leave stale Range objects behind.
  useEffect(() => {
    if (!active) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const onChange = () => scheduleRescan(true);

    scroller.addEventListener('scroll', onChange, { passive: true });
    const mo = new MutationObserver(onChange);
    mo.observe(scroller, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      scroller.removeEventListener('scroll', onChange);
      mo.disconnect();
    };
  }, [active, scrollerRef, scheduleRescan]);

  // Clear highlights on deactivation / unmount.
  useEffect(() => {
    if (!active) clearHighlights();
    return () => {
      clearHighlights();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [active, clearHighlights]);

  const next = useCallback(() => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    const nextIdx = (currentIndexRef.current + 1) % total;
    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    paintHighlights(rangesRef.current, nextIdx);
    focusRange(nextIdx);
  }, [paintHighlights, focusRange]);

  const prev = useCallback(() => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    const nextIdx = currentIndexRef.current - 1 < 0 ? total - 1 : currentIndexRef.current - 1;
    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    paintHighlights(rangesRef.current, nextIdx);
    focusRange(nextIdx);
  }, [paintHighlights, focusRange]);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
  }, []);

  return {
    query,
    setQuery,
    matchCount,
    currentIndex,
    next,
    prev,
    supported,
    hasQuery: query.length > 0,
  };
}
