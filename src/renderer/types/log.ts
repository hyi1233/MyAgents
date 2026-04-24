/**
 * Shared log types for the unified logging system
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * v0.2.0+: Sidecar runs on Node.js, but the discriminant `'bun'` is kept
 * so pre-0.2.0 unified-log files (`~/.myagents/logs/unified-YYYY-MM-DD.log`)
 * parse correctly after an upgrade. The UI displays "NODE" for this key —
 * see `UnifiedLogsPanel.tsx::SOURCE_LABELS`.
 */
export type LogSource = 'bun' | 'rust' | 'react';

export interface LogEntry {
    source: LogSource;
    level: LogLevel;
    message: string;
    timestamp: string;
    meta?: Record<string, unknown>;
}
