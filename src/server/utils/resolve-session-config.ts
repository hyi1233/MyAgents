import type { AgentConfig, ChannelConfig } from '../../shared/types/agent';
import { resolveEffectiveConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';
import type { RuntimeType } from '../../shared/types/runtime';

/**
 * Effective runtime config for a single query (v0.1.69).
 *
 * Only the fields we actually snapshot. `systemPrompt` / tool registry /
 * provider definitions are deliberately NOT here — those stay live (shared
 * by all sessions, upgraded together).
 */
export interface ResolvedSessionConfig {
  runtime: RuntimeType;
  model: string | undefined;
  permissionMode: string | undefined;
  mcpEnabledServers: string[] | undefined;
  providerId: string | undefined;
  providerEnvJson: string | undefined;
}

/**
 * Only two behaviors: IM live-follows AgentConfig + ChannelOverrides; everyone
 * else (Desktop Tab, Cron new-task, Cron current-session) reads from the
 * session snapshot with Agent as fallback.
 *
 * Cron `new_task` looks like "live" but actually snapshots into a fresh
 * SessionMetadata per tick (T6), then reads that snapshot — so it's
 * structurally 'owned'.
 */
export type SessionOwnerKind = 'im' | 'owned';

/**
 * Resolve the effective config for one query (D2, D4, D7, Option C).
 *
 * - IM (`'im'`): every call re-merges `channel.overrides ?? agent`. No session
 *   snapshot read. This keeps the D4 live-follow semantic; IM session fork on
 *   runtime drift happens at the Router layer, not here.
 *
 * - Owned (`'owned'`): read session snapshot first; fall back to agent for any
 *   field the snapshot hasn't captured yet (lazy migration for legacy sessions
 *   that predate v0.1.69).
 *
 * The lazy fallback is **only a read-path concern** — it does NOT write back
 * into SessionMetadata. Backfill happens only on active writes (user sends a
 * message / changes a setting); see PRD §6.4.
 */
export function resolveSessionConfig(
  meta: SessionMetadata | null | undefined,
  agent: AgentConfig,
  channel: ChannelConfig | undefined,
  ownerKind: SessionOwnerKind,
): ResolvedSessionConfig {
  if (ownerKind === 'im') {
    if (!channel) {
      // Defensive: IM path without a channel shouldn't happen at runtime, but
      // degrade to agent-only rather than throw (keeps /health and startup
      // probes from face-planting on a half-initialized peer).
      return {
        runtime: agent.runtime ?? 'builtin',
        model: agent.model,
        permissionMode: agent.permissionMode,
        mcpEnabledServers: agent.mcpEnabledServers,
        providerId: agent.providerId,
        providerEnvJson: agent.providerEnvJson,
      };
    }
    const eff = resolveEffectiveConfig(agent, channel);
    return {
      runtime: eff.runtime,
      model: eff.model,
      permissionMode: eff.permissionMode,
      mcpEnabledServers: eff.mcpEnabledServers,
      providerId: eff.providerId,
      providerEnvJson: eff.providerEnvJson,
    };
  }

  // owned (Desktop + Cron): session snapshot first, agent fallback per field
  return {
    runtime: meta?.runtime ?? agent.runtime ?? 'builtin',
    model: meta?.model ?? agent.model,
    permissionMode: meta?.permissionMode ?? agent.permissionMode,
    mcpEnabledServers: meta?.mcpEnabledServers ?? agent.mcpEnabledServers,
    providerId: meta?.providerId ?? agent.providerId,
    providerEnvJson: meta?.providerEnvJson ?? agent.providerEnvJson,
  };
}
