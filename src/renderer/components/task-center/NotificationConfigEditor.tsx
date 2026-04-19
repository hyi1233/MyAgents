// NotificationConfigEditor — shared UI for configuring per-task notifications.
// Used inside DispatchTaskDialog (at task creation) and TaskDetailOverlay
// (edit after the fact). PRD §7.3 / §8.2 / §12.
//
// Current UI surface (trimmed for v0.1.69 — the `chat_id` input and event
// subscription pills were deemed too power-usery for a first-time user
// and removed):
//   • desktop toggle
//   • bot channel dropdown
//
// `botThread` is still carried on `NotificationConfig`; the backend
// projects it through to CronTask.delivery's chat_id. For now it's set
// to `undefined` (→ server-side `_auto_` sentinel → bot router picks
// the default chat). `events` is also preserved on the payload and
// defaults to `['done','blocked','endCondition']` which is the same set
// the dispatch_notification path uses. If either becomes
// user-configurable again, re-expose here without touching backend
// contracts.

import { useMemo } from 'react';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import type { NotificationConfig } from '@/../shared/types/task';

const DEFAULT_EVENTS: NonNullable<NotificationConfig['events']> = [
  'done',
  'blocked',
  'endCondition',
];

interface Props {
  value?: NotificationConfig;
  onChange: (next: NotificationConfig) => void;
}

export function NotificationConfigEditor({ value, onChange }: Props) {
  const { statuses } = useAgentStatuses();

  const channelOptions: SelectOption[] = useMemo(() => {
    const out: SelectOption[] = [{ value: '', label: '不发送到 Bot' }];
    for (const agent of Object.values(statuses)) {
      for (const ch of agent.channels) {
        out.push({
          value: ch.channelId,
          label: `${agent.agentName} · ${ch.name ?? ch.channelType}`,
        });
      }
    }
    return out;
  }, [statuses]);

  const current: NotificationConfig = {
    desktop: value?.desktop ?? true,
    botChannelId: value?.botChannelId,
    botThread: value?.botThread,
    events: value?.events ?? DEFAULT_EVENTS,
  };

  const patch = (p: Partial<NotificationConfig>) => onChange({ ...current, ...p });

  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
      <div className="flex items-center justify-between text-[12px] text-[var(--ink)]">
        <span>桌面通知</span>
        <Toggle
          checked={current.desktop}
          onChange={(v) => patch({ desktop: v })}
          ariaLabel="桌面通知开关"
        />
      </div>

      <div>
        <label className="mb-1 block text-[12px] text-[var(--ink-secondary)]">
          发送到 IM Bot（可选）
        </label>
        <CustomSelect
          value={current.botChannelId ?? ''}
          options={channelOptions}
          onChange={(v) => patch({ botChannelId: v || undefined })}
          placeholder="不发送到 Bot"
          compact
        />
      </div>
    </div>
  );
}

/**
 * Design-system-compliant toggle switch (DESIGN.md §6.6). 44×24px capsule
 * with a 20px white slider. Uses `--accent` when on, `--line-strong` when off.
 */
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default NotificationConfigEditor;
