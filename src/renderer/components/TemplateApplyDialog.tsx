/**
 * TemplateApplyDialog — pick a template and merge it into the CURRENT workspace.
 *
 * Counterpart to `launcher/TemplateLibraryDialog.tsx` (which creates a NEW workspace).
 * The two have separate UIs because the two flows have meaningfully different inputs:
 * create-workspace asks for a target dir + project name + icon; apply-to-current uses
 * the existing agentDir as-is and just needs template selection + overwrite confirmation.
 *
 * Two-step UX:
 *   1. List templates → select one → click "应用".
 *   2. Backend `cmd_template_apply_preview` returns the file overwrite/add lists →
 *      a confirmation view shows what will be written. User confirms → backend
 *      `cmd_apply_template_to_workspace` performs the merge.
 *
 * Same-name files in the workspace are overwritten; everything else is preserved.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, FilePlus, FileWarning, ArrowLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import type { WorkspaceTemplate } from '@/config/types';
import { PRESET_TEMPLATES } from '@/config/types';
import { loadUserTemplates } from '@/config/services/templateService';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import WorkspaceIcon from './launcher/WorkspaceIcon';

interface TemplateApplyDialogProps {
    /** Workspace path that the template will be merged into. */
    agentDir: string;
    onClose: () => void;
    /** Called after a successful apply so the caller can refresh content. */
    onApplied?: () => void;
}

interface ApplyPreview {
    overwrite: string[];
    add: string[];
}

type Step = 'pick' | 'confirm';

export default function TemplateApplyDialog({ agentDir, onClose, onApplied }: TemplateApplyDialogProps) {
    useCloseLayer(() => { onClose(); return true; }, 220);

    const [step, setStep] = useState<Step>('pick');
    const [templates, setTemplates] = useState<WorkspaceTemplate[]>([...PRESET_TEMPLATES]);
    const [selectedId, setSelectedId] = useState<string>(PRESET_TEMPLATES[0]?.id ?? '');
    const [loading, setLoading] = useState(false);      // preview / apply in flight
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<ApplyPreview | null>(null);

    // Load user templates alongside bundled ones
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const userTemplates = await loadUserTemplates();
                if (!cancelled) setTemplates([...PRESET_TEMPLATES, ...userTemplates]);
            } catch (err) {
                console.warn('[TemplateApply] Failed to load user templates:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const selectedTemplate = templates.find(t => t.id === selectedId) ?? null;

    /** Step 1 → 2: ask the backend which files would be overwritten. */
    const handleRequestApply = useCallback(async () => {
        if (!selectedTemplate) return;
        setLoading(true);
        setError(null);
        try {
            const args: Record<string, unknown> = { destPath: agentDir };
            if (selectedTemplate.isBuiltin) {
                args.templateId = selectedTemplate.id;
            } else if (selectedTemplate.path) {
                args.sourcePath = selectedTemplate.path;
            } else {
                throw new Error('Template has no source path');
            }
            const result = await invoke<ApplyPreview>('cmd_template_apply_preview', args);
            setPreview(result);
            setStep('confirm');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [selectedTemplate, agentDir]);

    /** Step 2: user confirmed — perform the merge. */
    const handleConfirmApply = useCallback(async () => {
        if (!selectedTemplate) return;
        setLoading(true);
        setError(null);
        try {
            const args: Record<string, unknown> = { destPath: agentDir };
            if (selectedTemplate.isBuiltin) {
                args.templateId = selectedTemplate.id;
            } else if (selectedTemplate.path) {
                args.sourcePath = selectedTemplate.path;
            } else {
                throw new Error('Template has no source path');
            }
            await invoke('cmd_apply_template_to_workspace', args);
            onApplied?.();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
        }
    }, [selectedTemplate, agentDir, onApplied, onClose]);

    return (
        <OverlayBackdrop onClose={onClose} className="z-[220]">
            <div className="flex w-[560px] max-h-[78vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <div className="flex items-center gap-3">
                        {step === 'confirm' && (
                            <button
                                type="button"
                                onClick={() => { setStep('pick'); setPreview(null); setError(null); }}
                                className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                title="返回"
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </button>
                        )}
                        <h2 className="text-base font-semibold text-[var(--ink)]">
                            {step === 'pick' ? '选择模板应用到当前工作区' : '确认应用'}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-auto px-6 py-4">
                    {step === 'pick' ? (
                        <ul className="flex flex-col gap-2">
                            {templates.map(t => {
                                const active = t.id === selectedId;
                                return (
                                    <li key={t.id}>
                                        <button
                                            type="button"
                                            onClick={() => setSelectedId(t.id)}
                                            className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                                                active
                                                    ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
                                                    : 'border-[var(--line)] hover:border-[var(--line-strong)] hover:bg-[var(--paper-inset)]'
                                            }`}
                                        >
                                            <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--paper)]">
                                                <WorkspaceIcon icon={t.icon} size={20} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-[var(--ink)]">{t.name}</span>
                                                    {t.isBuiltin && (
                                                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)] bg-[var(--paper-inset)]">
                                                            内置
                                                        </span>
                                                    )}
                                                </div>
                                                {t.description && (
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)] leading-relaxed">{t.description}</p>
                                                )}
                                            </div>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-[var(--ink-muted)]">
                                将「<span className="text-[var(--ink)]">{selectedTemplate?.name}</span>」模板的内容合并到当前工作区。
                                同名文件会被覆盖，工作区中其它文件保留不变。
                            </p>
                            {preview && preview.overwrite.length > 0 && (
                                <section>
                                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--warning)]">
                                        <FileWarning className="h-3.5 w-3.5" />
                                        将覆盖 {preview.overwrite.length} 个文件
                                    </h3>
                                    <ul className="max-h-[180px] overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-[11px] text-[var(--ink-muted)]">
                                        {preview.overwrite.map(f => <li key={f} className="py-0.5">{f}</li>)}
                                    </ul>
                                </section>
                            )}
                            {preview && preview.add.length > 0 && (
                                <section>
                                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--ink-secondary)]">
                                        <FilePlus className="h-3.5 w-3.5" />
                                        将新增 {preview.add.length} 个文件
                                    </h3>
                                    <ul className="max-h-[180px] overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-[11px] text-[var(--ink-muted)]">
                                        {preview.add.map(f => <li key={f} className="py-0.5">{f}</li>)}
                                    </ul>
                                </section>
                            )}
                            {preview && preview.overwrite.length === 0 && preview.add.length === 0 && (
                                <p className="text-xs text-[var(--ink-muted)]">模板为空，无文件可应用。</p>
                            )}
                        </div>
                    )}
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-6 mb-2 flex items-start gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={loading}
                        className="rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
                    >
                        取消
                    </button>
                    {step === 'pick' ? (
                        <button
                            type="button"
                            onClick={handleRequestApply}
                            disabled={loading || !selectedTemplate}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                        >
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            下一步
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleConfirmApply}
                            disabled={loading || !preview || (preview.overwrite.length === 0 && preview.add.length === 0)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                        >
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            确认应用
                        </button>
                    )}
                </div>
            </div>
        </OverlayBackdrop>
    );
}
