import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Loader2, Puzzle, Trash2 } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { ImBotConfig, ImPlatform, InstalledPlugin } from '../../../shared/types/im';
import { PROMOTED_PLUGINS } from './promotedPlugins';
import telegramIcon from './assets/telegram.png';
import feishuIcon from './assets/feishu.jpeg';
import dingtalkIcon from './assets/dingtalk.svg';

interface PlatformEntry {
    id: ImPlatform;
    name: string;
    description: string;
    icon?: string;
    iconElement?: React.ReactNode;
    plugin?: InstalledPlugin;
}

const STATIC_PLATFORMS: PlatformEntry[] = [
    {
        id: 'telegram',
        name: 'Telegram',
        description: '通过 Telegram Bot 远程使用 AI Agent',
        icon: telegramIcon,
    },
    {
        id: 'feishu',
        name: '飞书',
        description: '通过飞书自建应用 Bot 远程使用 AI Agent',
        icon: feishuIcon,
    },
    {
        id: 'dingtalk',
        name: '钉钉',
        description: '通过钉钉自建应用 Bot 远程使用 AI Agent',
        icon: dingtalkIcon,
    },
];

export default function PlatformSelect({
    botConfigs,
    onSelect,
    onSelectPlugin,
    onInstallPlugin,
    onCancel,
}: {
    botConfigs: ImBotConfig[];
    onSelect: (platform: ImPlatform) => void;
    onSelectPlugin: (plugin: InstalledPlugin) => void;
    onInstallPlugin: () => void;
    onCancel: () => void;
}) {
    const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
    const [loading, setLoading] = useState(true);
    const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
    const [autoInstalling, setAutoInstalling] = useState<string | null>(null); // pluginId being auto-installed
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!isTauriEnvironment()) {
                setLoading(false);
                return;
            }
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (!cancelled) setInstalledPlugins(plugins);
            } catch {
                // Ignore errors — just show no plugins
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleUninstall = useCallback(async () => {
        if (!pendingUninstall || !isTauriEnvironment()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('cmd_uninstall_openclaw_plugin', { pluginId: pendingUninstall.pluginId });
            // Disable any stopped bots that depend on this plugin
            const dependentBots = botConfigs.filter(
                b => b.openclawPluginId === pendingUninstall.pluginId
            );
            for (const bot of dependentBots) {
                try {
                    await invoke('cmd_update_im_bot_config', {
                        botId: bot.id,
                        patch: { enabled: false },
                    });
                } catch {
                    // Best-effort — bot config may already be in a bad state
                }
            }
            setInstalledPlugins(prev => prev.filter(p => p.pluginId !== pendingUninstall.pluginId));
            toastRef.current.success(`已卸载 ${pendingUninstall.manifest?.name || pendingUninstall.pluginId}`);
        } catch (err) {
            toastRef.current.error(String(err));
        } finally {
            setPendingUninstall(null);
        }
    }, [pendingUninstall, botConfigs]);

    // Auto-install a promoted plugin (click card → install → open wizard)
    const handlePromotedClick = useCallback(async (promoted: typeof PROMOTED_PLUGINS[number]) => {
        // Already installed? Go directly to wizard
        const existing = installedPlugins.find(p => p.pluginId === promoted.pluginId);
        if (existing) {
            onSelectPlugin(existing);
            return;
        }
        // Auto-install
        if (!isTauriEnvironment()) return;
        setAutoInstalling(promoted.pluginId);
        toastRef.current.info('首次启动正在安装插件，请稍等…');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', {
                npmSpec: promoted.npmSpec,
            });
            setInstalledPlugins(prev => [...prev, result]);
            onSelectPlugin(result);
        } catch (err) {
            toastRef.current.error(`安装失败: ${err}`);
        } finally {
            setAutoInstalling(null);
        }
    }, [installedPlugins, onSelectPlugin]);

    // IDs of promoted plugins (to exclude from community section)
    const promotedIds = new Set(PROMOTED_PLUGINS.map(p => p.pluginId));

    // Build dynamic platform entries from installed plugins (exclude promoted ones)
    const pluginPlatforms: PlatformEntry[] = installedPlugins
        .filter(p => !promotedIds.has(p.pluginId))
        .map((p) => ({
            id: `openclaw:${p.pluginId}` as ImPlatform,
            name: p.manifest?.name || p.pluginId,
            description: p.manifest?.description || `社区插件 — ${p.npmSpec}`,
            iconElement: (
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
                    <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
                </div>
            ),
            plugin: p,
        }));

    const allPlatforms = [...STATIC_PLATFORMS, ...pluginPlatforms];

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={onCancel}
                    className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">选择平台</h2>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        选择要接入的聊天平台
                    </p>
                </div>
            </div>

            {/* Platform cards */}
            <div className="grid grid-cols-2 gap-4">
                {allPlatforms.map((p) => (
                    <div key={p.id} className="group relative">
                        <button
                            onClick={() => {
                                if (p.plugin) {
                                    onSelectPlugin(p.plugin);
                                } else {
                                    onSelect(p.id);
                                }
                            }}
                            className="flex w-full flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
                        >
                            {p.icon ? (
                                <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
                            ) : p.iconElement ? (
                                p.iconElement
                            ) : null}
                            <div className="text-center">
                                <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">{p.description}</p>
                            </div>
                        </button>
                        {/* Uninstall button for community plugins */}
                        {p.plugin && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setPendingUninstall(p.plugin!); }}
                                title="卸载插件"
                                className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                ))}

                {/* Promoted plugins — displayed as static cards with auto-install */}
                {PROMOTED_PLUGINS.map((pp) => {
                    const isInstalling = autoInstalling === pp.pluginId;
                    return (
                        <button
                            key={`promoted-${pp.pluginId}`}
                            onClick={() => handlePromotedClick(pp)}
                            disabled={isInstalling || loading}
                            className="flex w-full flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px] disabled:opacity-70"
                        >
                            {isInstalling ? (
                                <Loader2 className="h-12 w-12 animate-spin text-[var(--ink-muted)]" />
                            ) : (
                                <img src={pp.icon} alt={pp.name} className="h-12 w-12 rounded-xl" />
                            )}
                            <div className="text-center">
                                <p className="text-sm font-medium text-[var(--ink)]">{pp.name}</p>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">{pp.description}</p>
                            </div>
                        </button>
                    );
                })}

                {/* Install new plugin card */}
                <button
                    onClick={onInstallPlugin}
                    disabled={loading}
                    className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] bg-transparent p-6 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                >
                    {loading ? (
                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                    ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
                            <Download className="h-6 w-6 text-[var(--ink-muted)]" />
                        </div>
                    )}
                    <div className="text-center">
                        <p className="text-sm font-medium text-[var(--ink-muted)]">安装新插件</p>
                        <p className="mt-1 text-xs text-[var(--ink-subtle)]">从 npm 安装 OpenClaw 社区插件</p>
                    </div>
                </button>
            </div>

            {pendingUninstall && (() => {
                const depCount = botConfigs.filter(
                    b => b.openclawPluginId === pendingUninstall.pluginId
                ).length;
                const depHint = depCount > 0
                    ? `\n\n有 ${depCount} 个 Bot 使用此插件，卸载后这些 Bot 将无法启动。`
                    : '';
                return (
                    <ConfirmDialog
                        title="卸载插件"
                        message={`确定要卸载「${pendingUninstall.manifest?.name || pendingUninstall.pluginId}」吗？插件数据将被删除。${depHint}`}
                        confirmText="卸载"
                        confirmVariant="danger"
                        onConfirm={handleUninstall}
                        onCancel={() => setPendingUninstall(null)}
                    />
                );
            })()}
        </div>
    );
}
