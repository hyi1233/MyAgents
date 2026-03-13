// Shown when a workspace is not yet an Agent — explains benefits + upgrade button
import { useCallback, useEffect, useRef } from 'react';
import { HeartPulse } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import type { AgentConfig } from '../../../shared/types/agent';
import { addAgentConfig } from '@/config/services/agentConfigService';

interface AgentUpgradePromptProps {
  projectId: string;
  workspacePath: string;
  onUpgraded?: (agentId: string) => void;
}

export default function AgentUpgradePrompt({ projectId, workspacePath, onUpgraded }: AgentUpgradePromptProps) {
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleUpgrade = useCallback(async () => {
    try {
      const project = projects.find(p => p.id === projectId);
      const agentConfig: AgentConfig = {
        id: crypto.randomUUID(),
        name: project?.displayName || project?.name || workspacePath.split('/').pop() || 'Agent',
        enabled: true,
        workspacePath,
        providerId: project?.providerId ?? undefined,
        model: project?.model ?? undefined,
        permissionMode: project?.permissionMode || config.defaultPermissionMode || 'plan',
        mcpEnabledServers: project?.mcpEnabledServers,
        channels: [],
      };

      // Persist agent config via TypeScript service (maintains imBotConfigs shim)
      await addAgentConfig(agentConfig);

      // Mark project as agent
      await patchProject(projectId, { isAgent: true, agentId: agentConfig.id });
      await refreshConfig();

      if (isMountedRef.current) onUpgraded?.(agentConfig.id);
    } catch (e) {
      console.error('[AgentUpgradePrompt] Upgrade failed:', e);
    }
  }, [projectId, workspacePath, config, projects, patchProject, refreshConfig, onUpgraded]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      <HeartPulse className="h-10 w-10 text-[var(--heartbeat)]" />
      <h2 className="text-lg font-semibold text-[var(--ink)]">
        升级为 Agent
      </h2>
      <p className="max-w-md text-center text-sm text-[var(--ink-muted)]">
        将此工作区升级为 Agent 后，可以添加 IM Channel（飞书、Telegram、钉钉等），
        让 AI 通过多个渠道与用户交互，共享同一份工作区和工具配置。
      </p>
      <ul className="max-w-md text-sm text-[var(--ink-muted)]">
        <li className="mb-1">• 多 Channel 共享一个工作区和 MCP 工具</li>
        <li className="mb-1">• 独立的 AI 模型和权限覆盖配置</li>
        <li className="mb-1">• 统一的心跳和定时任务管理</li>
        <li>• 智能主动消息路由</li>
      </ul>
      <button
        className="rounded-lg bg-[var(--button-primary-bg)] px-6 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        onClick={handleUpgrade}
      >
        升级为 Agent
      </button>
    </div>
  );
}
