// NotificationConfigEditor — shared UI for configuring per-task notifications.
// Used inside DispatchTaskDialog (at task creation) and TaskDetailOverlay
// (edit after the fact). PRD §7.3 / §8.2 / §12.
//
// Desktop toggle + bot channel dropdown + optional bot thread (chat_id) +
// subscribed events selector. All fields optional — blank means "use defaults".

import { useMemo } from 'react';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import type { NotificationConfig } from '@/../shared/types/task';

const ALL_EVENTS: Array<{
  value: NonNullable<NotificationConfig['events']>[number];
  label: string;
}> = [
  { value: 'done', label: '完成' },
  { value: 'blocked', label: '阻塞' },
  { value: 'stopped', label: '暂停' },
  { value: 'verifying', label: '进入验证' },
  { value: 'endCondition', label: '循环收敛' },
];

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

  const toggleEvent = (
    ev: NonNullable<NotificationConfig['events']>[number],
  ) => {
    const set = new Set(current.events ?? DEFAULT_EVENTS);
    if (set.has(ev)) {
      set.delete(ev);
    } else {
      set.add(ev);
    }
    patch({ events: Array.from(set) });
  };

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

      {current.botChannelId && (
        <div>
          <label className="mb-1 block text-[12px] text-[var(--ink-secondary)]">
            具体会话 chat_id（留空默认）
          </label>
          <input
            type="text"
            value={current.botThread ?? ''}
            onChange={(e) =>
              patch({ botThread: e.target.value || undefined })
            }
            placeholder="例如飞书 chat_id / Telegram chat_id"
            className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1 text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
          />
        </div>
      )}

      <div>
        <div className="mb-1 text-[12px] text-[var(--ink-secondary)]">
          订阅哪些状态事件
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_EVENTS.map((e) => {
            const active = (current.events ?? DEFAULT_EVENTS).includes(e.value);
            return (
              <button
                key={e.value}
                type="button"
                onClick={() => toggleEvent(e.value)}
                aria-pressed={active}
                className={`rounded-[var(--radius-md)] px-2.5 py-1 text-[11px] transition-colors ${
                  active
                    ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)] font-medium'
                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                }`}
              >
                {e.label}
              </button>
            );
          })}
        </div>
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
