// Hook for handling system tray events and window close behavior
// Manages minimize-to-tray functionality and exit confirmation

import { useEffect, useCallback, useRef } from 'react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { setWindowVisible, consumePendingNavigation } from '@/services/notificationService';

interface TrayEventsOptions {
  /** Whether minimize to tray is enabled */
  minimizeToTray: boolean;
  /** Callback when settings should be opened */
  onOpenSettings?: () => void;
  /** Callback when exit is requested (for confirmation if cron tasks are running) */
  onExitRequested?: () => Promise<boolean>;
  /** Callback when notification click triggers navigation to a specific tab */
  onNavigateToTab?: (tabId: string) => void;
  /** Callback when Cmd+W should close a tab (after overlay dismissal, before tray/exit).
   *  Returns true if a tab was closed (stop here), false if no tab to close (proceed to tray/exit). */
  onCloseTab?: () => boolean;
}

export function useTrayEvents(options: TrayEventsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Handle window hide (minimize to tray)
  const hideWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.hide();
      console.log('[useTrayEvents] Window hidden to tray');
    } catch (error) {
      console.error('[useTrayEvents] Failed to hide window:', error);
    }
  }, []);

  // Handle window close (either hide or exit)
  const closeWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error('[useTrayEvents] Failed to close window:', error);
    }
  }, []);

  // Confirm and exit the app
  const confirmExit = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { emit } = await import('@tauri-apps/api/event');
      // Emit event to Rust to confirm exit
      await emit('tray:confirm-exit');
    } catch (error) {
      console.error('[useTrayEvents] Failed to emit exit event:', error);
    }
  }, []);

  // Setup event listeners
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenCloseRequested: (() => void) | null = null;
    let unlistenOpenSettings: (() => void) | null = null;
    let unlistenExitRequested: (() => void) | null = null;
    let unlistenFocusChanged: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();

        // Listen for window focus changes (including when window is shown from tray)
        // Track previous visibility to detect hidden→visible transitions
        let wasHidden = false;
        unlistenFocusChanged = await window.onFocusChanged(({ payload: focused }) => {
          console.debug('[useTrayEvents] Window focus changed:', focused);
          if (focused) {
            // Only consume pending navigation when window transitions from hidden to visible
            // (not on every focus event, which would hijack navigation on alt-tab)
            const shouldConsumeNav = wasHidden;
            wasHidden = false;

            // Window is now visible and focused
            setWindowVisible(true);

            if (shouldConsumeNav) {
              // Check if a notification was recently sent — auto-navigate to that tab
              const targetTabId = consumePendingNavigation();
              if (targetTabId) {
                console.log('[useTrayEvents] Auto-navigating to tab from notification:', targetTabId);
                optionsRef.current.onNavigateToTab?.(targetTabId);
              }
            }
          }
        });

        // Listen for window close request (X button AND native Cmd+W on macOS).
        // On macOS, Cmd+W triggers Tauri CloseRequested BEFORE JS keydown (the window
        // hides → "app has no keyWindow" → JS keydown is skipped entirely).
        // So the closeLayer logic MUST run here, not in the JS keydown handler.
        unlistenCloseRequested = await listen('window:close-requested', async () => {
          console.log('[useTrayEvents] Window close requested');

          // Hierarchical close: try to dismiss topmost overlay/panel first.
          // Import lazily to avoid circular deps.
          const { dismissTopmost } = await import('@/utils/closeLayer');
          if (dismissTopmost()) {
            console.log('[useTrayEvents] Overlay dismissed by closeLayer, skipping window close');
            return;
          }
          // Safety net: if no overlay registered but a backdrop-blur overlay IS visible
          // (unregistered overlay), block close to prevent unexpected window hide/exit.
          const hasOverlayBackdrop = !!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]');
          if (hasOverlayBackdrop) {
            console.log('[useTrayEvents] Unregistered overlay visible, blocking window close');
            return;
          }

          // Try closing the current tab before falling through to tray/exit.
          // This gives Cmd+W the layer: overlay → tab → tray/exit.
          const { onCloseTab } = optionsRef.current;
          if (onCloseTab && onCloseTab()) {
            console.log('[useTrayEvents] Tab closed by onCloseTab, skipping window close');
            return;
          }

          const { minimizeToTray } = optionsRef.current;

          if (minimizeToTray) {
            // Hide to tray instead of closing
            const window = getCurrentWindow();
            await window.hide();
            wasHidden = true;
            setWindowVisible(false); // Update notification service state
            console.log('[useTrayEvents] Window hidden to tray');
          } else {
            // Check if exit callback returns true (can exit)
            const { onExitRequested } = optionsRef.current;
            if (onExitRequested) {
              const canExit = await onExitRequested();
              if (canExit) {
                const { emit } = await import('@tauri-apps/api/event');
                await emit('tray:confirm-exit');
              }
            } else {
              const { emit } = await import('@tauri-apps/api/event');
              await emit('tray:confirm-exit');
            }
          }
        });

        // Listen for tray "open settings" menu click
        unlistenOpenSettings = await listen('tray:open-settings', () => {
          console.log('[useTrayEvents] Open settings from tray');
          const { onOpenSettings } = optionsRef.current;
          if (onOpenSettings) {
            onOpenSettings();
          }
        });

        // Listen for tray "exit" menu click
        unlistenExitRequested = await listen('tray:exit-requested', async () => {
          console.log('[useTrayEvents] Exit requested from tray');
          const { onExitRequested } = optionsRef.current;
          if (onExitRequested) {
            const canExit = await onExitRequested();
            if (canExit) {
              const { emit } = await import('@tauri-apps/api/event');
              await emit('tray:confirm-exit');
            }
          } else {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('tray:confirm-exit');
          }
        });

        console.log('[useTrayEvents] Event listeners setup complete');
      } catch (error) {
        console.error('[useTrayEvents] Failed to setup listeners:', error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenCloseRequested) unlistenCloseRequested();
      if (unlistenOpenSettings) unlistenOpenSettings();
      if (unlistenExitRequested) unlistenExitRequested();
      if (unlistenFocusChanged) unlistenFocusChanged();
    };
  }, []);

  return {
    hideWindow,
    closeWindow,
    confirmExit,
  };
}
