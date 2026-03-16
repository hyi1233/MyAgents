// Agent memory auto-update section (v0.1.43)
import { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { MemoryAutoUpdateConfig } from '../../../../shared/types/im';
import { DEFAULT_MEMORY_AUTO_UPDATE_CONFIG } from '../../../../shared/types/im';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { useToast } from '@/components/Toast';

const FilePreviewModal = lazy(() => import('../../FilePreviewModal'));

interface AgentMemoryUpdateSectionProps {
  agent: AgentConfig;
  onAgentChanged: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 24, label: '24 小时' },
  { value: 48, label: '48 小时' },
  { value: 72, label: '72 小时' },
] as const;

const DEFAULT_UPDATE_MEMORY_CONTENT = `---
description: >
  记忆自动更新指令 — MyAgents 会在夜间自动读取本文件的正文部分作为 prompt，
  注入到活跃 session 中执行记忆维护。你可以自由修改正文内容来调整更新策略。
---

你是一个 AI Agent，现在需要执行定期记忆维护。请按以下步骤操作：

1. **读取近期日志**
   - 读取 \`memory/\` 目录下今天及上次维护后的所有 \`YYYY-MM-DD.md\` 日志文件
   - 如果不确定上次维护时间，读取最近 3 天的日志

2. **更新主题记忆**
   - 根据日志中涉及的项目/话题，更新 \`memory/topics/\` 下对应的主题文件
   - 如果某个话题没有对应文件，创建新的主题文件
   - 每个主题文件应包含：关键决策、经验教训、当前状态、待办事项

3. **提炼核心记忆**
   - 将跨项目的重要经验、用户偏好、关键决策提炼到 \`.claude/rules/04-MEMORY.md\`
   - 保持精简，只保留对未来工作有指导意义的内容

4. **整理工作区**
   - 清理过期的临时文件或笔记
   - 确保目录结构整洁

5. **提交变更**
   - \`git add\` 所有记忆相关的文件变更
   - \`git commit\` 并附带简洁的提交信息（如 "memory: daily update YYYY-MM-DD"）
   - \`git push\`
`;

export default function AgentMemoryUpdateSection({ agent, onAgentChanged }: AgentMemoryUpdateSectionProps) {
  const config = agent.memoryAutoUpdate;
  const heartbeatEnabled = agent.heartbeat?.enabled ?? false;

  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [previewFile, setPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);

  const updateConfig = useCallback(async (patch: Partial<MemoryAutoUpdateConfig>) => {
    const current = agent.memoryAutoUpdate ?? { ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG, enabled: false };
    await patchAgentConfig(agent.id, {
      memoryAutoUpdate: { ...current, ...patch },
    });
    onAgentChanged();
  }, [agent.id, agent.memoryAutoUpdate, onAgentChanged]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !(config?.enabled ?? false);

    if (newEnabled) {
      // Auto-create UPDATE_MEMORY.md if not exists
      try {
        const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
        const sep = agent.workspacePath.includes('\\') ? '\\' : '/';
        const filePath = `${agent.workspacePath}${sep}UPDATE_MEMORY.md`;
        try {
          await readTextFile(filePath);
          // File exists, don't overwrite
        } catch {
          // File doesn't exist, create with default content
          await writeTextFile(filePath, DEFAULT_UPDATE_MEMORY_CONTENT);
          toastRef.current.success('已创建 UPDATE_MEMORY.md');
        }
      } catch (e) {
        console.warn('[AgentMemoryUpdateSection] Failed to create UPDATE_MEMORY.md:', e);
        toastRef.current.error('无法创建 UPDATE_MEMORY.md，请检查工作区路径');
        return; // Don't persist enabled=true if file creation failed
      }
    }

    await updateConfig({ enabled: newEnabled });
  }, [config?.enabled, agent.workspacePath, updateConfig]);

  const handleOpenFile = useCallback(async () => {
    if (!agent.workspacePath) return;
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const sep = agent.workspacePath.includes('\\') ? '\\' : '/';
      const filePath = `${agent.workspacePath}${sep}UPDATE_MEMORY.md`;
      let content = '';
      try {
        content = await readTextFile(filePath);
      } catch {
        // File doesn't exist
      }
      setPreviewFile({ name: 'UPDATE_MEMORY.md', content, size: new TextEncoder().encode(content).length, path: filePath });
    } catch (e) {
      console.warn('[AgentMemoryUpdateSection] Failed to open UPDATE_MEMORY.md:', e);
    }
  }, [agent.workspacePath]);

  const handleDirectSave = useCallback(async (content: string) => {
    if (!previewFile) return;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(previewFile.path, content);
  }, [previewFile]);

  const handleRevealFile = useCallback(async () => {
    if (!previewFile) return;
    const parentDir = previewFile.path.substring(0, previewFile.path.lastIndexOf('/'))
      || previewFile.path.substring(0, previewFile.path.lastIndexOf('\\'));
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parentDir);
  }, [previewFile]);

  // Don't show if heartbeat is disabled
  if (!heartbeatEnabled) return null;

  const enabled = config?.enabled ?? false;
  const intervalHours = config?.intervalHours ?? 24;
  const queryThreshold = config?.queryThreshold ?? 5;
  const windowStart = config?.updateWindowStart ?? '00:00';
  const windowEnd = config?.updateWindowEnd ?? '06:00';

  // Last batch info
  const lastBatchAt = config?.lastBatchAt;
  const lastBatchCount = config?.lastBatchSessionCount;
  let lastBatchLabel = '';
  if (lastBatchAt) {
    const dt = new Date(lastBatchAt);
    const diffMs = Date.now() - dt.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) lastBatchLabel = '不到 1 小时前';
    else if (diffH < 24) lastBatchLabel = `${diffH} 小时前`;
    else lastBatchLabel = `${Math.floor(diffH / 24)} 天前`;
    if (lastBatchCount !== undefined && lastBatchCount !== null) {
      lastBatchLabel += ` · ${lastBatchCount} 个 session 已更新`;
    }
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header + Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-[var(--ink)]">记忆自动更新</h3>
            <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
              在夜间自动读取{' '}
              <button
                type="button"
                onClick={handleOpenFile}
                className="text-[var(--accent)] hover:underline"
              >
                UPDATE_MEMORY.md
              </button>
              {' '}中的指令，对各活跃 session 执行记忆维护
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
              enabled ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-[var(--paper)] shadow transform transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </button>
        </div>

        {enabled && (
          <div className="space-y-4 pl-0">
            {/* Interval */}
            <div>
              <label className="block text-xs font-medium text-[var(--ink-subtle)] mb-1.5">更新间隔</label>
              <div className="flex gap-2">
                {INTERVAL_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateConfig({ intervalHours: opt.value as 24 | 48 | 72 })}
                    className={`rounded-md px-3 py-1 text-xs transition-colors ${
                      intervalHours === opt.value
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--paper-inset)] text-[var(--ink-subtle)] hover:bg-[var(--paper-hover)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Update Window */}
            <div>
              <label className="block text-xs font-medium text-[var(--ink-subtle)] mb-1.5">更新时间窗口</label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={windowStart}
                  onChange={e => updateConfig({ updateWindowStart: e.target.value })}
                  className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)] border border-[var(--line)]"
                />
                <span className="text-xs text-[var(--ink-subtle)]">—</span>
                <input
                  type="time"
                  value={windowEnd}
                  onChange={e => updateConfig({ updateWindowEnd: e.target.value })}
                  className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)] border border-[var(--line)]"
                />
                <span className="text-xs text-[var(--ink-faint)] ml-1">
                  {config?.updateWindowTimezone || agent.heartbeat?.activeHours?.timezone || 'Asia/Shanghai'}
                </span>
              </div>
            </div>

            {/* Threshold */}
            <div>
              <label className="block text-xs font-medium text-[var(--ink-subtle)] mb-1.5">触发阈值</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--ink-subtle)]">自上次更新后至少</span>
                <input
                  type="number"
                  min={3}
                  max={50}
                  value={queryThreshold}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 3 && v <= 50) updateConfig({ queryThreshold: v });
                  }}
                  className="w-14 rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)] text-center border border-[var(--line)]"
                />
                <span className="text-xs text-[var(--ink-subtle)]">条新对话才会触发</span>
              </div>
            </div>

            {/* Last batch info */}
            {lastBatchLabel && (
              <div className="border-t border-dashed border-[var(--line)] pt-3">
                <span className="text-xs text-[var(--ink-subtle)]">
                  上次更新{'  '}{lastBatchLabel}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* FilePreviewModal */}
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={previewFile.name}
            content={previewFile.content}
            size={previewFile.size}
            path={previewFile.path}
            onClose={() => setPreviewFile(null)}
            onSave={handleDirectSave}
            onRevealFile={handleRevealFile}
          />
        </Suspense>
      )}
    </>
  );
}
