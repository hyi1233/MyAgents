/**
 * useVirtuosoScroll — thin wrapper around react-virtuoso's scroll API.
 *
 * Three-state follow model:
 *  - `'force'`: always follow (after scrollToBottom, until confirmed at bottom)
 *  - `true`:    follow when at bottom (normal streaming)
 *  - `false`:   disabled (user scrolled up, or paused for rewind/retry)
 *
 * Transitions:
 *  scrollToBottom() → 'force'
 *  atBottomStateChange(true) + force → true  (confirmed at bottom, normal follow)
 *  atBottomStateChange(false) + true → false  (user scrolled up, stop following)
 *  pauseAutoScroll() → false (temporary, auto-restores to true)
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

export interface VirtuosoScrollControls {
    virtuosoRef: React.RefObject<VirtuosoHandle | null>;
    scrollerRef: React.MutableRefObject<HTMLElement | null>;
    followEnabledRef: React.MutableRefObject<boolean | 'force'>;
    scrollToBottom: () => void;
    pauseAutoScroll: (duration?: number) => void;
    /** Pass to Virtuoso's atBottomStateChange — manages follow state transitions */
    handleAtBottomChange: (atBottom: boolean) => void;
}

export function useVirtuosoScroll(
    _isLoading: boolean,
    _messagesLength: number,
    _sessionId?: string | null,
): VirtuosoScrollControls {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    const followEnabledRef = useRef<boolean | 'force'>(true);
    const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const scrollToBottom = useCallback(() => {
        followEnabledRef.current = 'force';
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    }, []);

    const pauseAutoScroll = useCallback((duration = 500) => {
        followEnabledRef.current = false;
        if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = setTimeout(() => {
            followEnabledRef.current = true;
            pauseTimerRef.current = null;
        }, duration);
    }, []);

    /** Called by Virtuoso when the list transitions between at-bottom and not-at-bottom */
    const handleAtBottomChange = useCallback((atBottom: boolean) => {
        if (atBottom && followEnabledRef.current === 'force') {
            // Confirmed at bottom after scrollToBottom() — switch to normal follow
            followEnabledRef.current = true;
        }
        if (!atBottom && followEnabledRef.current === true) {
            // User scrolled away from bottom during normal follow — disable
            followEnabledRef.current = false;
        }
        // Note: !atBottom + 'force' → stay in force (still scrolling to bottom)
        // Note: !atBottom + false → already disabled, no change
    }, []);

    useEffect(() => {
        return () => {
            if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        };
    }, []);

    return { virtuosoRef, scrollerRef, followEnabledRef, scrollToBottom, pauseAutoScroll, handleAtBottomChange };
}
