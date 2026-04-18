// Legacy cron → new Task upgrade helper (PRD §11.4 "批量升级入口").
//
// Maps an existing CronTask (no `task_id` back-pointer) into a brand-new
// Task without losing schedule, prompt, workspace, end conditions, delivery
// config, runtime snapshot, or the cron's own run history. The existing
// CronTask is kept running; only its back-pointer is rewritten so the Task
// Center drives it through the v0.1.69 detail overlay from here on.
//
// Flow:
//   1. Create a user-level Thought with the cron's original prompt so the
//      new Task has a proper `sourceThoughtId` (v1 requires it).
//   2. Derive `TaskCreateDirectInput` from the cron — type / schedule /
//      end conditions / notification / runtime snapshot all carry over.
//   3. `taskCreateDirect` writes the jsonl row + `.task/<id>/task.md`.
//   4. `taskSetCron` writes `Task.cron_task_id` → existing cron id.
//   5. `cmd_cron_set_task_id` writes `CronTask.task_id` → new task id.
//      After this, the legacy-surfacing filter hides the row from the
//      legacy list, and the Task Center drives it through
//      TaskDetailOverlay instead of LegacyCronOverlay.

import { cronSetTaskId, taskCreateDirect, taskSetCron, thoughtCreate } from '@/api/taskCenter';
import type { Project } from '@/config/types';
import type {
  EndConditions,
  NotificationConfig,
  RuntimeConfigSnapshot,
  Task,
  TaskCreateDirectInput,
  TaskExecutionMode,
  TaskRunMode,
} from '@/../shared/types/task';
import type { RuntimeType } from '@/../shared/types/runtime';

export interface LegacyCronRaw {
  id?: string;
  name?: string;
  prompt?: string;
  status?: string;
  workspacePath?: string;
  workspaceId?: string;
  schedule?: Record<string, unknown> | null;
  intervalMinutes?: number;
  endConditions?: EndConditions;
  /** Rust-side snake_case variant — defend against either. */
  end_conditions?: EndConditions;
  notifyEnabled?: boolean;
  notify_enabled?: boolean;
  delivery?: { botId?: string; chatId?: string; platform?: string };
  runMode?: TaskRunMode;
  run_mode?: TaskRunMode;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  runtime_config?: RuntimeConfigSnapshot;
  model?: string;
  permissionMode?: string;
  permission_mode?: string;
  [key: string]: unknown;
}

/** Map `CronSchedule.kind` onto `TaskExecutionMode`. */
function deriveExecutionMode(
  schedule: Record<string, unknown> | null | undefined,
): TaskExecutionMode {
  const kind = (schedule?.kind as string | undefined) ?? '';
  if (kind === 'at') return 'scheduled';
  if (kind === 'loop') return 'loop';
  // 'every' / 'cron' / unknown → treat as recurring (matches the current
  // legacy overlay's `describeSchedule` fallback).
  return 'recurring';
}

function deriveNotification(legacy: LegacyCronRaw): NotificationConfig {
  const enabled = legacy.notifyEnabled ?? legacy.notify_enabled ?? true;
  const cfg: NotificationConfig = {
    desktop: enabled,
    events: ['done', 'blocked', 'endCondition'],
  };
  if (legacy.delivery?.botId) cfg.botChannelId = legacy.delivery.botId;
  if (legacy.delivery?.chatId) cfg.botThread = legacy.delivery.chatId;
  return cfg;
}

/** Look up workspaceId from the projects list by matching `workspacePath`. */
function resolveWorkspaceId(path: string, projects: Project[]): string | null {
  const hit = projects.find((p) => p.path === path);
  return hit?.id ?? null;
}

function deriveName(legacy: LegacyCronRaw): string {
  const candidate = (legacy.name ?? '').trim();
  if (candidate) return candidate.length <= 120 ? candidate : candidate.slice(0, 118) + '…';
  // Fall back to the first non-empty line of the prompt (PRD §8.2 pattern).
  const firstLine =
    (legacy.prompt ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  const body = firstLine.trim() || '未命名定时任务';
  return body.length <= 60 ? body : body.slice(0, 57) + '…';
}

export interface UpgradeResult {
  task: Task;
  thoughtId: string;
}

/**
 * Upgrade one legacy cron into a new-model Task. Reuses the existing
 * CronTask — no schedule interruption — and wires both-sided back-pointers.
 */
export async function upgradeLegacyCron(
  legacy: LegacyCronRaw,
  projects: Project[],
): Promise<UpgradeResult> {
  const cronTaskId = String(legacy.id ?? '').trim();
  if (!cronTaskId) throw new Error('缺少 CronTask id，无法升级');
  const workspacePath = String(legacy.workspacePath ?? '').trim();
  if (!workspacePath) throw new Error('缺少工作区路径，无法升级');
  const workspaceId = resolveWorkspaceId(workspacePath, projects);
  if (!workspaceId) {
    throw new Error(
      `找不到工作区：${workspacePath}。请先在启动页添加该工作区，然后重试升级。`,
    );
  }

  const prompt = String(legacy.prompt ?? '').trim();
  if (!prompt) throw new Error('旧任务没有 prompt，无法派生 task.md');

  // Step 1: mint a thought whose content == the cron's original prompt,
  // satisfying the v1 invariant that every Task has a `sourceThoughtId`.
  const thought = await thoughtCreate({ content: prompt });

  // Step 2: derive the input.
  const input: TaskCreateDirectInput = {
    name: deriveName(legacy),
    executor: 'agent',
    workspaceId,
    workspacePath,
    taskMdContent: prompt,
    executionMode: deriveExecutionMode(legacy.schedule),
    runMode: legacy.runMode ?? legacy.run_mode ?? 'new-session',
    endConditions: legacy.endConditions ?? legacy.end_conditions ?? { aiCanExit: true },
    sourceThoughtId: thought.id,
    tags: [],
    notification: deriveNotification(legacy),
  };
  if (legacy.runtime) input.runtime = legacy.runtime;
  const runtimeConfig = legacy.runtimeConfig ?? legacy.runtime_config;
  if (runtimeConfig) input.runtimeConfig = runtimeConfig;

  // Step 3: create the Task. Rust will NOT touch the cron here — it only
  // does that when `taskRun` is called.
  const task = await taskCreateDirect(input);

  // Step 4/5: wire both back-pointers. If step 5 fails we still have a
  // Task and a cron-id back-pointer pointing to the wrong owner; try to
  // roll back step 4 so the user isn't stuck with a dangling reference.
  try {
    await taskSetCron(task.id, cronTaskId);
    await cronSetTaskId(cronTaskId, task.id);
  } catch (e) {
    // Best-effort rollback — if this also fails, at least surface the
    // original error so the user knows what went wrong.
    try {
      await taskSetCron(task.id, null);
    } catch {
      /* ignore rollback failure */
    }
    throw e;
  }

  return { task, thoughtId: thought.id };
}
