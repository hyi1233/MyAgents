import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';

/**
 * Session config snapshot helpers (v0.1.69).
 *
 * Two independent helpers for two owner policies. **Do not** collapse them
 * into an enum-dispatched single function — the split is intentional
 * pit-of-success: each call site self-documents which snapshot policy it
 * wants, and a compile error is the only thing that can silently change
 * behavior when a new field is added.
 *
 * Callers feed the returned `Partial<SessionMetadata>` to
 * `createSessionMetadata(agentDir, snapshot)`. Hand-assembling snapshot
 * fields outside these helpers is forbidden (see PRD §6.2 Pit-of-success).
 */

/**
 * IM (Agent channel) owner — live-follow policy (D4).
 *
 * IM sessions deliberately do NOT snapshot model/permission/mcp; each message
 * re-resolves `agent + channel.overrides` live so the Telegram/Feishu/etc. peer
 * tracks the Agent's current config. Only `runtime` is recorded, because runtime
 * drift triggers session fork at the Router layer (sidecar.rs + router.rs) and
 * needs a stable reference.
 *
 * `runtimeSessionId` is left absent — it is filled in by the runtime on first
 * `session/new` / thread creation.
 */
export function snapshotForImSession(agent: AgentConfig): Partial<SessionMetadata> {
  return {
    runtime: agent.runtime ?? 'builtin',
  };
}

/**
 * Desktop Tab / Cron owner — full-snapshot policy (D2, D3, D9).
 *
 * Desktop sessions own their config: once created, the session is self-contained
 * and is not affected by later changes to AgentConfig (D1). Cron `new_task`
 * tick creates a fresh snapshot each run (every tick reads current Agent);
 * Cron `current_session` freezes at first creation and reuses forever.
 */
export function snapshotForOwnedSession(agent: AgentConfig): Partial<SessionMetadata> {
  return {
    runtime: agent.runtime ?? 'builtin',
    model: agent.model,
    permissionMode: agent.permissionMode,
    mcpEnabledServers: agent.mcpEnabledServers ? [...agent.mcpEnabledServers] : undefined,
    providerId: agent.providerId,
    providerEnvJson: agent.providerEnvJson,
    configSnapshotAt: new Date().toISOString(),
  };
}
