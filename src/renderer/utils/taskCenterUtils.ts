/**
 * Shared utilities for Task Center components
 * (RecentTasks, TaskCenterOverlay, CronTaskDetailPanel, SessionHistoryDropdown)
 */

import type { SessionMetadata } from '@/api/sessionClient';
import { findPromotedPlugin } from '@/components/ImSettings/promotedPlugins';

const PREVIEW_MAX_LENGTH = 35;

/**
 * Extract folder name from path (cross-platform)
 * Returns 'Workspace' for empty/invalid paths
 */
export function getFolderName(path: string): string {
    if (!path) return 'Workspace';
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || 'Workspace';
}

/**
 * Format ISO timestamp as relative time (zh-CN)
 */
export function formatTime(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return '昨天';
    } else if (diffDays < 7) {
        return `${diffDays}天前`;
    } else {
        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
}

/**
 * Check if session source indicates IM bot origin
 */
export function isImSource(source: SessionMetadata['source']): boolean {
    if (!source) return false;
    // Built-in IM platforms + OpenClaw channels all use "<platform>_private" / "<platform>_group"
    return (source.endsWith('_private') || source.endsWith('_group')) && source !== 'desktop';
}

/**
 * Get truncated display text for a session (35 chars max).
 * AI-generated or user-set titles take priority over message previews.
 */
export function getSessionDisplayText(session: SessionMetadata): string {
    // AI/user titles are semantic — prefer them
    if (session.titleSource === 'auto' || session.titleSource === 'user') {
        const raw = session.title || '';
        return raw.length <= PREVIEW_MAX_LENGTH ? raw : raw.slice(0, PREVIEW_MAX_LENGTH) + '...';
    }
    // Fallback: message preview > default title
    const raw = session.lastMessagePreview || session.title;
    if (raw.length <= PREVIEW_MAX_LENGTH) return raw;
    return raw.slice(0, PREVIEW_MAX_LENGTH) + '...';
}

/**
 * Extract platform display name from a session key.
 * Handles both legacy (`im:{platform}:{type}:{id}`) and
 * new agent format (`agent:{agentId}:{channelType}:{sourceType}:{id}`).
 */
export function extractPlatformDisplay(sessionKey: string): string {
    const parts = sessionKey.split(':');
    // New agent format: agent:{agentId}:{channelType}:{private|group}:{id}
    if (parts[0] === 'agent' && parts.length >= 5) {
        const channelType = parts[2] ?? 'unknown';
        if (channelType.startsWith('openclaw:')) {
            const pluginId = channelType.slice('openclaw:'.length);
            const promoted = findPromotedPlugin(pluginId);
            return promoted?.name ?? (pluginId.charAt(0).toUpperCase() + pluginId.slice(1));
        }
        if (channelType === 'openclaw' && parts[3]) {
            const promoted = findPromotedPlugin(parts[3]);
            return promoted?.name ?? (parts[3].charAt(0).toUpperCase() + parts[3].slice(1));
        }
        return channelType.charAt(0).toUpperCase() + channelType.slice(1);
    }
    // Legacy format: im:{platform}:{type}:{id}
    const platform = parts[1] ?? 'unknown';
    if (platform === 'openclaw' && parts[2]) {
        const channelId = parts[2];
        const promoted = findPromotedPlugin(channelId);
        return promoted?.name ?? (channelId.charAt(0).toUpperCase() + channelId.slice(1));
    }
    return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * Format message count suffix (e.g., "3 条消息")
 */
export function formatMessageCount(session: SessionMetadata): string | null {
    const count = session.stats?.messageCount;
    if (!count || count <= 0) return null;
    return `${count} 条消息`;
}
