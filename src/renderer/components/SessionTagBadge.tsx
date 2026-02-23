/**
 * SessionTagBadge - Tag badges for session sources (IM, Cron, Background)
 */

import type { SessionTag } from '@/hooks/useTaskCenterData';

export default function SessionTagBadge({ tag }: { tag: SessionTag }) {
    if (tag.type === 'im') {
        return (
            <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                {tag.platform}
            </span>
        );
    }
    if (tag.type === 'cron') {
        return (
            <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                心跳
            </span>
        );
    }
    if (tag.type === 'background') {
        return (
            <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                后台
            </span>
        );
    }
    return null;
}
