// Convenience wrapper around the Radix UI Select primitives. The
// standard @radix-ui/react-select API requires nested SelectTrigger +
// SelectContent + SelectItem components for every picker, which adds a
// lot of boilerplate inside form-style screens. This wrapper accepts
// a flat `options` array (and an optional onChange handler) so the
// builder UI can drop it into the grid the same way it uses <Input>.
//
// Two layouts:
//
//   1. Flat — pass `options: [{ value, label }, ...]` for the
//      usual case.
//   2. Grouped — pass `groups: [{ label, options: [...] }, ...]`
//      to render Radix `SelectGroup` + `SelectLabel` headers. Used
//      by the profile form's "Preferred Resume Template" picker
//      so admins can see admin-uploaded templates and drag-drop
//      templates in clearly labeled sections.
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue
} from './select';
import { cn } from '@/lib/utils';

export function SelectField({
    value,
    onChange,
    options,
    groups,
    placeholder = 'Select…',
    className
}) {
    return (
        <Select value={value} onValueChange={(v) => onChange && onChange(v)}>
            <SelectTrigger className={cn('h-10', className)}>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {groups
                    ? groups.map((group) => (
                        <SelectGroup key={group.label}>
                            <SelectLabel>{group.label}</SelectLabel>
                            {group.options.map((opt) => (
                                <SelectItem
                                    key={String(opt.value)}
                                    value={String(opt.value)}
                                >
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ))
                    : (options || []).map((opt) => (
                        <SelectItem
                            key={String(opt.value)}
                            value={String(opt.value)}
                        >
                            {opt.label}
                        </SelectItem>
                    ))}
            </SelectContent>
        </Select>
    );
}