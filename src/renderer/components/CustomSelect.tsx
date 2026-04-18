/**
 * CustomSelect - Custom dropdown select component
 * Replaces native <select> with styled dropdown matching design system.
 * Positioning is delegated to the shared `<Popover>` primitive, which
 * portals to <body> and auto-flips when there isn't room below.
 */

import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useCallback, useRef, useState } from 'react';

import { Popover } from '@/components/ui/Popover';

export interface SelectOption {
    value: string;
    label: string;
    icon?: ReactNode;
    /** Right-aligned suffix content (e.g., status badge) */
    suffix?: ReactNode;
    /** Renders as a non-selectable section header/divider */
    isSeparator?: boolean;
}

interface CustomSelectProps {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    triggerIcon?: ReactNode;
    className?: string;
    compact?: boolean;
    footerAction?: {
        label: string;
        icon?: ReactNode;
        onClick: () => void;
    };
}

export default function CustomSelect({
    value,
    options,
    onChange,
    placeholder = '请选择',
    triggerIcon,
    className,
    compact,
    footerAction,
}: CustomSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const selectedOption = options.find(o => o.value === value);

    const handleSelect = useCallback((optionValue: string) => {
        onChange(optionValue);
        setIsOpen(false);
    }, [onChange]);

    return (
        <div className={`relative ${className ?? ''}`}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] text-left transition-colors hover:border-[var(--ink-subtle)] ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-xs'}`}
            >
                {triggerIcon && (
                    <span className="shrink-0 text-[var(--ink-muted)]">{triggerIcon}</span>
                )}
                <span className={`min-w-0 flex-1 truncate ${selectedOption ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}>
                    {selectedOption?.label ?? placeholder}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            <Popover
                open={isOpen}
                onClose={() => setIsOpen(false)}
                anchorRef={triggerRef}
                placement="bottom-start"
                matchAnchorWidth
                className="max-h-60 overflow-auto py-1 shadow-md"
                // Elevated above modal backdrops since selects are often
                // rendered inside OverlayBackdrop-wrapped dialogs.
                zIndex={300}
            >
                {options.map(option =>
                    option.isSeparator ? (
                        <div key={option.value} className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]/50">
                            {option.label}
                        </div>
                    ) : (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => handleSelect(option.value)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                option.value === value
                                    ? 'text-[var(--accent-warm)]'
                                    : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                            }`}
                        >
                            {option.icon && (
                                <span className="shrink-0">{option.icon}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.suffix && (
                                <span className="shrink-0">{option.suffix}</span>
                            )}
                            {option.value === value && (
                                <Check className="h-3 w-3 shrink-0" />
                            )}
                        </button>
                    )
                )}

                {footerAction && (
                    <>
                        <div className="my-1 border-t border-[var(--line)]" />
                        <button
                            type="button"
                            onClick={() => {
                                setIsOpen(false);
                                footerAction.onClick();
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                        >
                            {footerAction.icon && (
                                <span className="shrink-0">{footerAction.icon}</span>
                            )}
                            <span>{footerAction.label}</span>
                        </button>
                    </>
                )}
            </Popover>
        </div>
    );
}
