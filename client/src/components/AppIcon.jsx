import { cn } from '@/lib/utils';

/** Lumi mark — teal monogram, readable at toolbar size. */
export default function AppIcon({ size = 32, className, title = 'Lumi' }) {
    const s = Number(size) || 32;
    const gid = `lumi-bg-${s}`;
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 128 128"
            width={s}
            height={s}
            className={cn('shrink-0', className)}
            role="img"
            aria-label={title}
        >
            <defs>
                <linearGradient id={gid} x1="20" y1="8" x2="108" y2="120" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#22D3EE" />
                    <stop offset="1" stopColor="#0E7490" />
                </linearGradient>
            </defs>
            <rect width="128" height="128" rx="28" fill={`url(#${gid})`} />
            <path d="M42 34h14v44h30v14H42V34z" fill="#0B1220" />
            <circle cx="92" cy="42" r="10" fill="#ECFEFF" />
            <path
                d="M88 42h8M92 38v8"
                stroke="#0E7490"
                strokeWidth="2.8"
                strokeLinecap="round"
            />
        </svg>
    );
}
