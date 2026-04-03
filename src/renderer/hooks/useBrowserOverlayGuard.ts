/**
 * useBrowserOverlayGuard — Detects visible overlay elements that would
 * cover the native browser Webview.
 *
 * Returns `true` when a visible fixed-position overlay exists, `false` otherwise.
 * The caller (BrowserPanel) uses this in a combined visibility effect to decide
 * whether to show/hide the native Webview.
 *
 * Detection strategy: scan `document.body` direct children (overlays use
 * `createPortal(el, document.body)`) for elements with `position: fixed`
 * and significant size (not zero-size hidden elements).
 * Also checks `data-suppress-browser` attribute as a manual escape hatch.
 *
 * Uses MutationObserver on body's direct children (childList only, no subtree)
 * + rAF debounce for minimal overhead.
 */

import { useEffect, useRef, useState } from 'react';

function checkOverlays(): boolean {
  // Check data-suppress-browser anywhere in the doc (rare, explicit marker)
  if (document.querySelector('[data-suppress-browser]')) return true;

  // Scan body's direct children for visible fixed overlays
  // (overlays mount via createPortal to document.body)
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (
      style.position === 'fixed' &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      child.offsetWidth > 0 &&
      child.offsetHeight > 0
    ) {
      return true;
    }
  }
  return false;
}

export function useBrowserOverlayGuard(active: boolean): boolean {
  const [overlayDetected, setOverlayDetected] = useState(false);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!active) return;

    const sync = () => {
      setOverlayDetected(checkOverlays());
    };

    // Debounce via rAF
    const debouncedSync = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(sync);
    };

    // Only watch body's direct children (where createPortal mounts overlays)
    const observer = new MutationObserver(debouncedSync);
    observer.observe(document.body, { childList: true });

    // Initial check
    sync();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafIdRef.current);
      setOverlayDetected(false);
    };
  }, [active]);

  return overlayDetected;
}
