import BrandMark from '@/components/BrandMark';
import AppIcon from '@/components/AppIcon';

/**
 * Auth — new Lumi app entry.
 */
export default function AuthLayout({ title, subtitle, children }) {
    return (
        <div className="relative flex min-h-screen bg-[hsl(222_28%_6%)]">
            <div
                className="pointer-events-none absolute inset-0"
                aria-hidden
                style={{
                    background:
                        'radial-gradient(ellipse 70% 50% at 10% 0%, hsl(199 95% 55% / 0.2), transparent 55%), radial-gradient(ellipse 50% 40% at 100% 100%, hsl(210 90% 48% / 0.12), transparent 50%)'
                }}
            />

            <div className="relative hidden w-[42%] flex-col justify-between overflow-hidden border-r border-white/[0.06] p-10 xl:p-14 lg:flex">
                <div className="pointer-events-none absolute inset-0 auth-panel-texture" aria-hidden />
                <BrandMark />
                <div className="relative max-w-md space-y-4">
                    <p className="font-display text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
                        New workspace
                    </p>
                    <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-white">
                        Apply with Lumi
                    </h1>
                    <p className="text-sm leading-relaxed text-white/50">
                        Pipeline, performance, and resume tooling in one redesigned workspace.
                    </p>
                </div>
                <p className="relative font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
                    Internal · Lumi
                </p>
            </div>

            <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-12">
                <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
                    <AppIcon size={48} />
                    <BrandMark compact />
                </div>
                <div className="w-full max-w-md">
                    {(title || subtitle) && (
                        <div className="mb-6">
                            {title && (
                                <h2 className="font-display text-2xl font-semibold tracking-tight text-white">
                                    {title}
                                </h2>
                            )}
                            {subtitle && <p className="mt-2 text-sm text-white/45">{subtitle}</p>}
                        </div>
                    )}
                    <div className="rounded-3xl border border-white/[0.08] bg-[hsl(222_24%_9%/0.9)] p-6 shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8),0_0_0_1px_hsla(199,95%,55%,0.12)] backdrop-blur-xl sm:p-8">
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}
