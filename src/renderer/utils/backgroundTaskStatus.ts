/**
 * Module-level store for background task (SDK sub-agent) completion statuses.
 *
 * Solves a timing problem: `chat:task-notification` SSE events may fire
 * before the corresponding TaskTool component mounts its event listener.
 * By writing to this Map first, TaskTool can read the status on mount
 * and also subscribe to future changes via the DOM event.
 */

/** Terminal statuses emitted by the SDK's task_notification system messages. */
export type BackgroundTaskTerminalStatus = 'completed' | 'error' | 'failed' | 'stopped';

const TERMINAL: Set<string> = new Set<string>(['completed', 'error', 'failed', 'stopped']);

/** Check whether a status string is terminal (task is done). */
export function isTerminalStatus(status: string | undefined): status is BackgroundTaskTerminalStatus {
    return !!status && TERMINAL.has(status);
}

const statuses = new Map<string, string>();
const descriptions = new Map<string, string>();

// Bidirectional toolUseId ↔ taskId mapping.
// SDK emits `task_started` with both IDs; `task_notification` only has taskId.
// TaskTool components know their `tool.id` (= toolUseId) but not the taskId.
// This mapping bridges the gap so TaskTool can look up status by toolUseId.
const toolUseIdToTaskId = new Map<string, string>();
const taskIdToToolUseId = new Map<string, string>();

const EVENT_NAME = 'background-task-status';

/** Register the toolUseId↔taskId mapping (called when chat:task-started arrives). */
export function registerBackgroundTask(taskId: string, toolUseId: string): void {
    toolUseIdToTaskId.set(toolUseId, taskId);
    taskIdToToolUseId.set(taskId, toolUseId);
}

/** Called by TabProvider when `chat:task-started` arrives. Stores description for later display. */
export function setBackgroundTaskDescription(taskId: string, description: string): void {
    descriptions.set(taskId, description);
}

/** Read task description (set at task-started time). */
export function getBackgroundTaskDescription(taskId: string): string | undefined {
    return descriptions.get(taskId);
}

/** Called by TabProvider when `chat:task-notification` arrives. */
export function setBackgroundTaskStatus(taskId: string, status: string): void {
    statuses.set(taskId, status);
    // Dispatch event with BOTH taskId and toolUseId so TaskTool (which only
    // knows its toolUseId = tool.id) can match the notification to itself.
    const toolUseId = taskIdToToolUseId.get(taskId);
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { taskId, toolUseId, status },
    }));
}

/**
 * Read current status by toolUseId (the key TaskTool components have).
 * Falls back to direct taskId lookup for backward compatibility.
 */
export function getBackgroundTaskStatus(key: string): string | undefined {
    // Try as toolUseId first (new path), then as taskId (old path / direct)
    const taskId = toolUseIdToTaskId.get(key) ?? key;
    return statuses.get(taskId);
}

/** Clear all entries — call on session reset to prevent unbounded growth. */
export function clearAllBackgroundTaskStatuses(): void {
    statuses.clear();
    descriptions.clear();
    toolUseIdToTaskId.clear();
    taskIdToToolUseId.clear();
}

/** Event name for addEventListener — exported to avoid magic strings. */
export const BACKGROUND_TASK_STATUS_EVENT = EVENT_NAME;
