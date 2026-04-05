// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { broadcast } from '../sse';
import { buildSystemPromptAppend } from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import type { AgentRuntime, RuntimeProcess, UnifiedEvent } from './types';
import { getExternalRuntime, getCurrentRuntimeType, isExternalRuntime } from './factory';
import type { RuntimeType } from '../../shared/types/runtime';

// ─── Module state ───

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let isRunning = false;
let turnCompleted = false;

// Track session context for multi-turn resume (CC -p mode exits after each turn)
let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastCcSessionId = '';  // CC's internal session ID (from hook or system.init)

/**
 * Set CC's session ID (called from hook endpoint or system.init event).
 * Used for --resume in multi-turn conversations.
 */
export function setCcSessionId(id: string): void {
  lastCcSessionId = id;
  console.log(`[external-session] CC session ID set: ${id}`);
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  return isExternalRuntime(getCurrentRuntimeType());
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
}): Promise<void> {
  if (isRunning) {
    console.warn('[external-session] Session already running, ignoring start request');
    return;
  }

  const runtimeType = getCurrentRuntimeType();
  const runtime = getExternalRuntime(runtimeType);
  activeRuntime = runtime;

  // Build system prompt using MyAgents' three-layer architecture
  const systemPromptAppend = buildSystemPromptAppend(options.scenario);

  console.log(`[external-session] Starting ${runtimeType} session for ${options.sessionId}`);
  turnCompleted = false;

  // Broadcast user message so frontend displays it in the chat
  if (options.initialMessage) {
    broadcast('chat:message-replay', {
      message: {
        id: `user-${Date.now()}`,
        role: 'user',
        content: options.initialMessage,
        timestamp: new Date().toISOString(),
      },
    });
  }

  broadcast('chat:status', { sessionState: 'running' });

  try {
    const process = await runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        initialMessage: options.initialMessage,
        systemPromptAppend,
        model: options.model,
        permissionMode: options.permissionMode,
        scenario: options.scenario,
        resumeSessionId: options.resumeSessionId,
      },
      handleUnifiedEvent,
    );

    // Atomically set both process and running flag
    activeProcess = process;
    isRunning = true;
    // Track for multi-turn resume
    lastSessionId = options.sessionId;
    lastWorkspacePath = options.workspacePath;
    lastScenario = options.scenario;
    console.log(`[external-session] ${runtimeType} process started, pid=${activeProcess.pid}`);
  } catch (err) {
    isRunning = false;
    activeProcess = null;
    activeRuntime = null;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-session] Failed to start ${runtimeType}:`, message);
    broadcast('chat:status', { sessionState: 'error' });
    broadcast('chat:agent-error', { message: `Failed to start ${runtimeType}: ${message}` });
    // Re-throw so the HTTP handler returns an error response
    throw err;
  }
}

/**
 * Session context for first-time initialization (passed from index.ts)
 */
export interface ExternalSendContext {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 */
export async function sendExternalMessage(
  text: string,
  _images?: unknown[],
  _permissionMode?: string,
  _model?: string,
  context?: ExternalSendContext,
): Promise<{ queued: boolean; error?: string }> {
  // Case 1: No previous session — start fresh
  if (!lastCcSessionId && !isRunning) {
    if (!context) {
      return { queued: false, error: 'No session context for first message' };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        permissionMode: context.permissionMode,
        scenario: context.scenario,
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  if (!activeProcess || activeProcess.exited) {
    console.log(`[external-session] Previous process exited, resuming session ${lastCcSessionId}`);
    try {
      await startExternalSession({
        sessionId: lastSessionId,
        workspacePath: lastWorkspacePath,
        initialMessage: text,
        permissionMode: context?.permissionMode,
        scenario: lastScenario,
        resumeSessionId: lastCcSessionId, // --resume to continue conversation
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 3: Process still running — send via stdin
  if (!activeRuntime) {
    return { queued: false, error: 'No active runtime' };
  }
  try {
    broadcast('chat:status', { sessionState: 'running' });
    await activeRuntime.sendMessage(activeProcess, text);
    return { queued: true };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Respond to a permission request from the external runtime
 */
export async function respondExternalPermission(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  if (!activeProcess || !activeRuntime) {
    console.warn('[external-session] No active process for permission response');
    return;
  }
  await activeRuntime.respondPermission(activeProcess, requestId, approved, reason);
}

/**
 * Stop the active external session
 */
export async function stopExternalSession(): Promise<boolean> {
  if (!activeProcess || !activeRuntime) return false;
  try {
    await activeRuntime.stopSession(activeProcess);
    return true;
  } catch (err) {
    console.error('[external-session] Error stopping session:', err);
    activeProcess.kill();
    return true;
  } finally {
    activeProcess = null;
    activeRuntime = null;
    isRunning = false;
    broadcast('chat:status', { sessionState: 'idle' });
  }
}

/**
 * Check if an external session is active
 */
export function isExternalSessionActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(runtimeType: RuntimeType): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return await runtime.queryModels();
  } catch (err) {
    console.error(`[external-session] Failed to query models for ${runtimeType}:`, err);
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

function handleUnifiedEvent(event: UnifiedEvent): void {
  switch (event.kind) {
    case 'text_delta':
      broadcast('chat:message-chunk', event.text);
      break;

    case 'text_stop':
      // Text block ended — no direct SSE mapping needed
      break;

    case 'thinking_start':
      broadcast('chat:thinking-start', { index: event.index });
      break;

    case 'thinking_delta':
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', { index: event.index, delta: event.text });
      break;

    case 'thinking_stop':
      break;

    case 'tool_use_start':
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: {},
      });
      break;

    case 'tool_input_delta':
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      break;

    case 'tool_use_stop':
      broadcast('chat:content-block-stop', {
        type: 'tool_use',
        toolId: event.toolUseId,
      });
      break;

    case 'tool_result':
      broadcast('chat:tool-result-start', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
      });
      break;

    case 'permission_request':
      broadcast('permission:request', {
        requestId: event.requestId,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: event.input,
      });
      break;

    case 'session_init':
      // Capture CC's session ID for multi-turn resume
      if (event.sessionId) lastCcSessionId = event.sessionId;
      broadcast('chat:system-init', {
        info: {
          sessionId: event.sessionId,
          model: event.model,
          tools: event.tools,
        },
      });
      break;

    case 'status_change':
      broadcast('chat:status', { sessionState: event.state === 'running' ? 'running' : 'idle' });
      break;

    case 'turn_complete':
      // Mark turn complete — session_complete will follow for -p mode
      turnCompleted = true;
      broadcast('chat:message-complete', {});
      broadcast('chat:status', { sessionState: 'idle' });
      break;

    case 'session_complete':
      if (event.subtype === 'success') {
        // Only broadcast if turn_complete didn't already
        if (!turnCompleted) {
          broadcast('chat:message-complete', {});
        }
      } else {
        broadcast('chat:message-error', event.result || 'Session ended with error');
      }
      broadcast('chat:status', { sessionState: 'idle' });
      // Clean up module state — prevents stuck sessions on CC crash
      isRunning = false;
      activeProcess = null;
      activeRuntime = null;
      break;

    case 'usage':
      // Token usage — could broadcast if needed
      break;

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      break;

    case 'message_replay':
      // Skip assistant message replays during active streaming — CC sends both
      // stream_event deltas AND a complete assistant message, causing duplication.
      // Only replay user messages (for session resume scenarios).
      if (event.message.role === 'user') {
        broadcast('chat:message-replay', { message: event.message });
      }
      // Assistant replays are intentionally dropped — the stream_event deltas
      // already delivered the content to the frontend incrementally.
      break;

    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}
