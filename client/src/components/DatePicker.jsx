import * as React from 'react';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * IMPORTANT — Why this looks the way it does
 * ==========================================
 *
 * The previous design used a Radix Popover with a custom calendar +
 * time selects. That failed because the popover was portaled to
 * document.body, OUTSIDE the parent <Dialog> DOM, and Radix modal
 * mode treated every click inside the popover as an "outside" click
 * that closed the dialog before the popover elements could react.
 *
 * The fix below uses the browser's native `<input type="date">` and
 * `<input type="datetime-local">` controls. The native picker is
 * rendered by the OS, never participates in our DOM, and can never
 * conflict with Radix portals, modal traps, or z-indexes.
 *
 * Both pickers are wrapped in a `<label>` element that contains both
 * the visible trigger div AND the native input. Clicking the label
 * forwards the click to the input, and the browser opens the native
 * picker. As an extra safety net we also call `input.showPicker()` on
 * wrapper click — that triggers the picker even on browsers where
 * the synthetic label-click is intercepted by an event listener.
 *
 * Contract
 * --------
 *   DatePicker       value: 'YYYY-MM-DD'       (e.target.value)
 *   DateTimePicker   value: 'YYYY-MM-DDTHH:mm' (e.target.value)
 *
 * Both are drop-in replacements for the matching native input.
 */
export function DatePicker({ value, onChange, className, disabled, placeholder = 'Pick a date', name, id, required, ...rest }) {
    const hasValue = Boolean(value);
    const inputRef = React.useRef(null);

    const handleClear = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange?.({ target: { value: '', name }, currentTarget: { value: '', name } });
        inputRef.current?.focus();
    };

    // Explicit showPicker() — called when the wrapper div is clicked
    // (e.g. when the user clicks the calendar icon or the visible
    // text). The label-wrapping trick handles the full-wrapper click,
    // but this guards against any focus / event-reach race in the
    // parent Dialog.
    const handleWrapperClick = (e) => {
        // Don't reopen the picker if the user clicked the X button.
        if (e.target.closest('button[aria-label="Clear date"]')) return;
        if (disabled) return;
        const el = inputRef.current;
        if (!el) return;
        if (typeof el.showPicker === 'function') {
            try { el.showPicker(); } catch (_) { /* Chromium throws on some focus paths */ }
        } else {
            el.focus();
        }
    };

    return (
        <label
            htmlFor={id}
            className={cn('relative block cursor-pointer', disabled && 'cursor-not-allowed', className)}
            onClick={handleWrapperClick}
        >
            <input
                ref={inputRef}
                type="date"
                id={id}
                name={name}
                value={value || ''}
                disabled={disabled}
                required={required}
                onChange={onChange}
                aria-label={placeholder}
                // The input is positioned to fully cover the wrapper
                // so the browser's date picker triggers on any click.
                // We keep it visible (no opacity-0) so the focus
                // ring renders correctly and so the browser reliably
                // opens the picker when the field is clicked.
                className="absolute inset-0 z-0 h-full w-full cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                {...rest}
            />
            <div
                className={cn(
                    'pointer-events-none relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm',
                    !hasValue && 'text-muted-foreground',
                    disabled && 'opacity-50'
                )}
            >
                <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">
                    {hasValue ? value : placeholder}
                </span>
                {hasValue && !disabled && (
                    <button
                        type="button"
                        aria-label="Clear date"
                        onClick={handleClear}
                        // Re-enable pointer events on the X button so
                        // the click doesn't propagate to the wrapper
                        // and reopen the picker.
                        className="pointer-events-auto ml-2 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
        </label>
    );
}

/**
 * DateTimePicker — drop-in replacement for `<input type="datetime-local">`.
 *
 * Same `value` / `onChange` shape as the native control: ISO string of the
 * form 'YYYY-MM-DDTHH:mm'. The browser's native datetime-local picker
 * handles the dropdown UI; we delegate entirely to it so there's no
 * custom popover that could conflict with the parent Dialog's modal
 * close handler.
 */
export function DateTimePicker({
    value,
    onChange,
    className,
    disabled,
    placeholder = 'Pick date & time',
    name,
    id,
    required,
    min,
    max,
    step = 60,
    ...rest
}) {
    const hasValue = Boolean(value);
    const inputRef = React.useRef(null);

    const handleClear = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange?.({ target: { value: '', name }, currentTarget: { value: '', name } });
        inputRef.current?.focus();
    };

    const handleWrapperClick = (e) => {
        if (e.target.closest('button[aria-label="Clear date & time"]')) return;
        if (disabled) return;
        const el = inputRef.current;
        if (!el) return;
        if (typeof el.showPicker === 'function') {
            try { el.showPicker(); } catch (_) { /* Chromium throws on some focus paths */ }
        } else {
            el.focus();
        }
    };

    // For display we want a friendlier label than the raw ISO string
    // (e.g. "Aug 17, 2026, 14:37"). When the user opens the picker
    // they see the OS-native calendar dialog. We compute the display
    // best-effort; we do NOT mutate the stored value (the underlying
    // contract stays 'YYYY-MM-DDTHH:mm').
    const display = React.useMemo(() => {
        if (!value) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
        if (!m) return value;
        const [, y, mo, d, hh, mi] = m;
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[Number(mo) - 1] || '';
        return `${month} ${Number(d)}, ${y}, ${hh}:${mi}`;
    }, [value]);

    return (
        <label
            htmlFor={id}
            className={cn('relative block cursor-pointer', disabled && 'cursor-not-allowed', className)}
            onClick={handleWrapperClick}
        >
            <input
                ref={inputRef}
                type="datetime-local"
                id={id}
                name={name}
                value={value || ''}
                disabled={disabled}
                required={required}
                min={min}
                max={max}
                step={step}
                onChange={onChange}
                aria-label={placeholder}
                className="absolute inset-0 z-0 h-full w-full cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                {...rest}
            />
            <div
                className={cn(
                    'pointer-events-none relative flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm',
                    !hasValue && 'text-muted-foreground',
                    disabled && 'opacity-50'
                )}
            >
                <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">
                    {hasValue ? display : placeholder}
                </span>
                {hasValue && !disabled && (
                    <button
                        type="button"
                        aria-label="Clear date & time"
                        onClick={handleClear}
                        className="pointer-events-auto ml-2 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
        </label>
    );
}
