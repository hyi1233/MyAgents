/**
 * CronTaskDetailPanel — Detail + Edit view for a scheduled task.
 * Toggles between read-only detail mode and inline edit mode.
 * Design aligned with TaskCreateModal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Clock, Pencil, Play, Square, Trash2, X } from 'lucide-react';

import type { CronTask, CronSchedule, CronEndConditions } from '@/types/cronTask';
import {
    getCronStatusText,
    getCronStatusColor,
    formatScheduleDescription,
    formatNextExecution,
    checkCanResume,
    MIN_CRON_INTERVAL,
} from '@/types/cronTask';
import { getFolderName } from '@/utils/taskCenterUtils';
import { useToast } from './Toast';
import ConfirmDialog from './ConfirmDialog';
import TaskRunHistory from './scheduled-tasks/TaskRunHistory';
import ScheduleTypeTabs from './scheduled-tasks/ScheduleTypeTabs';
import * as cronClient from '@/api/cronTaskClient';

interface CronTaskDetailPanelProps {
    task: CronTask;
    botInfo?: { name: string; platform: string };
    onClose: () => void;
    onDelete: (taskId: string) => Promise<void>;
    onResume: (taskId: string) => Promise<void>;
    onStop?: (taskId: string) => Promise<void>;
}

const INPUT_CLS = 'w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            {children}
        </h4>
    );
}

/** Label-on-top, value-below field. `inline` makes it horizontal for stats row. */
function DetailField({ label, value, inline }: { label: string; value: string | undefined; inline?: boolean }) {
    if (!value) return null;
    if (inline) {
        return (
            <div>
                <span className="text-[11px] text-[var(--ink-muted)]/60">{label}</span>
                <p className="text-[13px] text-[var(--ink-secondary)]">{value}</p>
            </div>
        );
    }
    return (
        <div>
            <span className="text-[12px] text-[var(--ink-muted)]">{label}</span>
            <p className="mt-0.5 text-[13px] text-[var(--ink)]">{value}</p>
        </div>
    );
}

/** Small tag/badge for end conditions & notification status */
function DetailTag({ label }: { label: string }) {
    return (
        <span className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2.5 py-1 text-[12px] text-[var(--ink-muted)]">
            {label}
        </span>
    );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-[13px] text-[var(--ink-muted)]">
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                checked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line-strong)] bg-transparent'
            }`}>
                {checked && <Check className="h-2.5 w-2.5" />}
            </span>
            {label}
        </button>
    );
}

export default function CronTaskDetailPanel({ task, botInfo, onClose, onDelete, onResume, onStop }: CronTaskDetailPanelProps) {
    const toast = useToast();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isResuming, setIsResuming] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    // ── Edit mode state ──
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editName, setEditName] = useState(task.name || '');
    const [editPrompt, setEditPrompt] = useState(task.prompt);
    const [editSchedule, setEditSchedule] = useState<CronSchedule | null>(task.schedule ?? null);
    const [editInterval, setEditInterval] = useState(task.intervalMinutes);
    const [editEndMode, setEditEndMode] = useState<'conditional' | 'forever'>(
        (task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever'
    );
    const [editDeadline, setEditDeadline] = useState(task.endConditions.deadline || '');
    const [editMaxExec, setEditMaxExec] = useState(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
    const [editAiCanExit, setEditAiCanExit] = useState(task.endConditions.aiCanExit);
    const [editNotify, setEditNotify] = useState(task.notifyEnabled);

    const isAtSchedule = editSchedule?.kind === 'at';

    // Escape key
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (isEditing) setIsEditing(false);
                else onClose();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose, isEditing]);

    const startEditing = useCallback(() => {
        setEditName(task.name || '');
        setEditPrompt(task.prompt);
        setEditSchedule(task.schedule ?? null);
        setEditInterval(task.intervalMinutes);
        setEditEndMode((task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever');
        setEditDeadline(task.endConditions.deadline || '');
        setEditMaxExec(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
        setEditAiCanExit(task.endConditions.aiCanExit);
        setEditNotify(task.notifyEnabled);
        setIsEditing(true);
    }, [task]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const endConditions: CronEndConditions = isAtSchedule
                ? { aiCanExit: false }
                : editEndMode === 'forever'
                    ? { aiCanExit: editAiCanExit }
                    : {
                        deadline: editDeadline ? new Date(editDeadline).toISOString() : undefined,
                        maxExecutions: editMaxExec ? parseInt(editMaxExec, 10) : undefined,
                        aiCanExit: editAiCanExit,
                    };

            await cronClient.updateCronTaskFields(task.id, {
                name: editName.trim() || undefined,
                prompt: editPrompt.trim(),
                schedule: editSchedule ?? undefined,
                intervalMinutes: editSchedule?.kind === 'every' ? editSchedule.minutes : editInterval,
                endConditions,
                notifyEnabled: editNotify,
            });

            toast.success('任务已更新');
            setIsEditing(false);
        } catch (err) {
            toast.error(`更新失败: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setIsSaving(false);
        }
    }, [task.id, editName, editPrompt, editSchedule, editInterval, editEndMode, editDeadline, editMaxExec, editAiCanExit, editNotify, isAtSchedule, toast]);

    const handleDelete = useCallback(async () => {
        setIsDeleting(true);
        try { await onDelete(task.id); onClose(); } catch { /* caller handles */ } finally {
            setIsDeleting(false);
            setShowDeleteConfirm(false);
        }
    }, [task.id, onDelete, onClose]);

    const handleResume = useCallback(async () => {
        setIsResuming(true);
        try { await onResume(task.id); } finally { setIsResuming(false); }
    }, [task.id, onResume]);

    const handleStop = useCallback(async () => {
        if (!onStop) return;
        setIsStopping(true);
        try { await onStop(task.id); } catch { /* caller handles */ } finally {
            setIsStopping(false);
            setShowStopConfirm(false);
        }
    }, [task.id, onStop]);

    const resumeCheck = checkCanResume(task);
    const displayName = task.name || task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
    const scheduleDesc = formatScheduleDescription(task);
    const nextExec = formatNextExecution(task.nextExecutionAt, task.status);
    const runModeLabel = task.runMode === 'single_session' ? '保持上下文' : '每次新建';


    const editErrors = useMemo(() => {
        if (!isEditing) return [];
        const errs: string[] = [];
        if (!editPrompt.trim()) errs.push('请输入 AI 指令');
        if (!editSchedule && editInterval < MIN_CRON_INTERVAL) errs.push(`间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
        return errs;
    }, [isEditing, editPrompt, editSchedule, editInterval]);

    return (
        <>
            {showDeleteConfirm && (
                <ConfirmDialog title="删除定时任务" message={`确定要删除「${displayName}」吗？此操作不可撤销。`}
                    confirmText="删除" cancelText="取消" confirmVariant="danger" loading={isDeleting}
                    onConfirm={handleDelete} onCancel={() => setShowDeleteConfirm(false)} />
            )}
            {showStopConfirm && (
                <ConfirmDialog title="停止定时任务" message={`确定要停止「${displayName}」吗？停止后可以重新恢复。`}
                    confirmText="停止" cancelText="取消" confirmVariant="danger" loading={isStopping}
                    onConfirm={handleStop} onCancel={() => setShowStopConfirm(false)} />
            )}

            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                style={{ animation: 'overlayFadeIn 200ms ease-out' }}
                onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
            >
                <div
                    className="flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg"
                    style={{ animation: 'overlayPanelIn 250ms ease-out' }}
                    onClick={e => e.stopPropagation()}
                >
                    {/* ── Header ── */}
                    <div className="flex shrink-0 items-center justify-between px-6 py-4">
                        <div className="flex min-w-0 items-center gap-2.5">
                            <Clock className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                            <h3 className="min-w-0 truncate text-[15px] font-semibold text-[var(--ink)]">
                                {isEditing ? '编辑定时任务' : displayName}
                            </h3>
                            {!isEditing && (
                                <span className={`shrink-0 text-[12px] font-medium ${getCronStatusColor(task.status)}`}>
                                    {getCronStatusText(task.status)}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={() => isEditing ? setIsEditing(false) : onClose()}
                            className="ml-2 shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* ── Body ── */}
                    <div className="flex-1 overflow-y-auto px-6 pb-6">
                        {isEditing ? (
                            /* ====== EDIT MODE ====== */
                            <>
                                <div className="space-y-4">
                                    <SectionTitle>基本信息</SectionTitle>
                                    <div>
                                        <label className="mb-1 block text-[13px] font-medium text-[var(--ink-secondary)]">
                                            任务名称<span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span>
                                        </label>
                                        <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                                            maxLength={50} placeholder="例如: 每日新闻摘要" className={INPUT_CLS} />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-[13px] font-medium text-[var(--ink-secondary)]">AI 指令</label>
                                        <textarea value={editPrompt} onChange={e => setEditPrompt(e.target.value)}
                                            rows={5} placeholder="描述你希望 AI 定时执行的任务..."
                                            className={`${INPUT_CLS} resize-none`} />
                                    </div>
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                <div>
                                    <SectionTitle>执行计划</SectionTitle>
                                    <div className="mt-3">
                                        <ScheduleTypeTabs value={editSchedule} intervalMinutes={editInterval}
                                            onChange={(s, m) => { setEditSchedule(s); setEditInterval(m); }} />
                                    </div>
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {!isAtSchedule && (
                                    <div>
                                        <SectionTitle>结束条件与通知</SectionTitle>
                                        <div className="mt-3 space-y-3">
                                            <div className="flex gap-2">
                                                <button type="button" onClick={() => setEditEndMode('conditional')}
                                                    className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                                                        editEndMode === 'conditional' ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--ink-muted)]'
                                                    }`}>条件停止</button>
                                                <button type="button" onClick={() => setEditEndMode('forever')}
                                                    className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                                                        editEndMode === 'forever' ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--ink-muted)]'
                                                    }`}>永久运行</button>
                                            </div>
                                            {editEndMode === 'conditional' && (
                                                <div className="space-y-2.5 pl-0.5">
                                                    <div className="flex items-center gap-2">
                                                        <Checkbox checked={!!editDeadline} onChange={v => setEditDeadline(v ? new Date(Date.now() + 86400000).toISOString().slice(0, 16) : '')} label="截止时间" />
                                                        {editDeadline && <input type="datetime-local" value={editDeadline.slice(0, 16)} onChange={e => setEditDeadline(e.target.value)}
                                                            className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-1 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none" />}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Checkbox checked={!!editMaxExec} onChange={v => setEditMaxExec(v ? '10' : '')} label="最大执行次数" />
                                                        {editMaxExec && <input type="number" min={1} max={999} value={editMaxExec} onChange={e => setEditMaxExec(e.target.value)}
                                                            className="w-16 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-1 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none" />}
                                                    </div>
                                                </div>
                                            )}
                                            <div className="space-y-2.5 pl-0.5">
                                                <Checkbox checked={editAiCanExit} onChange={setEditAiCanExit} label="允许 AI 自主结束任务" />
                                                <Checkbox checked={editNotify} onChange={setEditNotify} label="每次执行完发送通知" />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            /* ====== DETAIL MODE ====== */
                            /* Order matches edit mode: 基本信息 → AI指令 → 执行模式 → 执行计划 → 结束条件 → 运行统计 → 执行历史 */
                            <>
                                {/* Section: 基本信息 */}
                                <div className="space-y-3">
                                    <SectionTitle>基本信息</SectionTitle>
                                    <DetailField label="任务名称" value={displayName} />
                                    <DetailField label="执行 Agent" value={getFolderName(task.workspacePath)} />
                                    {botInfo && <DetailField label="来源" value={`${botInfo.name} (${botInfo.platform})`} />}
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {/* Section: AI 指令 */}
                                {task.prompt && (
                                    <>
                                        <div className="space-y-3">
                                            <SectionTitle>AI 指令</SectionTitle>
                                            <div className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words">
                                                {task.prompt}
                                            </div>
                                        </div>
                                        <div className="my-5 border-t border-[var(--line-subtle)]" />
                                    </>
                                )}

                                {/* Section: 执行模式 */}
                                <div className="space-y-3">
                                    <SectionTitle>执行模式</SectionTitle>
                                    <p className="text-[13px] text-[var(--ink-secondary)]">{runModeLabel === '每次新建' ? '新开对话（无记忆）' : '连续对话（保持上下文）'}</p>
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {/* Section: 执行计划 */}
                                <div className="space-y-3">
                                    <SectionTitle>执行计划</SectionTitle>
                                    <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--line)] px-3.5 py-3">
                                        <span className="text-[13px] font-medium text-[var(--ink)]">{scheduleDesc}</span>
                                        <span className={`text-[12px] ${task.status === 'running' ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink-muted)]/50'}`}>
                                            {task.status === 'running' ? `下次: ${nextExec}` : '已停止'}
                                        </span>
                                    </div>
                                    {task.model && <DetailField label="模型" value={task.model} />}
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {/* Section: 结束条件与通知 */}
                                <div className="space-y-3">
                                    <SectionTitle>结束条件与通知</SectionTitle>
                                    <div className="flex flex-wrap gap-2">
                                        <DetailTag label={task.endConditions.deadline ? `截止 ${new Date(task.endConditions.deadline).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '无截止'} />
                                        <DetailTag label={task.endConditions.maxExecutions ? `最多 ${task.endConditions.maxExecutions} 次` : '无限次'} />
                                        <DetailTag label={task.endConditions.aiCanExit ? 'AI 可退出' : 'AI 不可退出'} />
                                        <DetailTag label={task.notifyEnabled ? '通知开启' : '通知关闭'} />
                                    </div>
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {/* Section: 运行统计 */}
                                <div className="space-y-3">
                                    <SectionTitle>运行统计</SectionTitle>
                                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                                        <DetailField label="执行次数" value={task.endConditions.maxExecutions ? `${task.executionCount} / ${task.endConditions.maxExecutions}` : `${task.executionCount} 次`} inline />
                                        <DetailField label="上次执行" value={task.lastExecutedAt ? new Date(task.lastExecutedAt).toLocaleString('zh-CN') : '尚未执行'} inline />
                                        {task.exitReason && <DetailField label="退出原因" value={task.exitReason} inline />}
                                    </div>
                                    {task.lastError && <p className="text-[12px] text-[var(--error)]">{task.lastError}</p>}
                                </div>

                                <div className="my-5 border-t border-[var(--line-subtle)]" />

                                {/* Section: 执行历史 */}
                                <div>
                                    <SectionTitle>执行历史</SectionTitle>
                                    <div className="mt-2"><TaskRunHistory taskId={task.id} /></div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ── Footer ── */}
                    <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-3.5">
                        {isEditing ? (
                            <>
                                {editErrors.length > 0 ? (
                                    <p className="text-xs text-[var(--error)]">{editErrors[0]}</p>
                                ) : <div />}
                                <div className="flex items-center gap-2.5">
                                    <button onClick={() => setIsEditing(false)}
                                        className="rounded-[var(--radius-md)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors">
                                        取消
                                    </button>
                                    <button onClick={handleSave} disabled={editErrors.length > 0 || isSaving}
                                        className="rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-5 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                                        {isSaving ? '保存中...' : '保存'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <button onClick={() => setShowDeleteConfirm(true)}
                                    className="flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-2 text-[13px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]">
                                    <Trash2 className="h-3.5 w-3.5" />
                                    删除
                                </button>
                                <div className="flex items-center gap-2.5">
                                    <button onClick={startEditing}
                                        className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--line)] px-4 py-2 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]">
                                        <Pencil className="h-3.5 w-3.5" />
                                        编辑
                                    </button>
                                    {task.status === 'running' && onStop && (
                                        <button onClick={() => setShowStopConfirm(true)} disabled={isStopping}
                                            className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--error)]/30 px-4 py-2 text-[13px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:opacity-50">
                                            <Square className="h-3.5 w-3.5" />
                                            {isStopping ? '停止中...' : '停止'}
                                        </button>
                                    )}
                                    {task.status === 'stopped' && (
                                        resumeCheck.canResume ? (
                                            <button onClick={handleResume} disabled={isResuming}
                                                className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-5 py-2 text-[13px] font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50">
                                                <Play className="h-3.5 w-3.5" />
                                                {isResuming ? '恢复中...' : '恢复'}
                                            </button>
                                        ) : (
                                            <span className="text-[12px] text-[var(--ink-muted)]/50">{resumeCheck.reason}</span>
                                        )
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
