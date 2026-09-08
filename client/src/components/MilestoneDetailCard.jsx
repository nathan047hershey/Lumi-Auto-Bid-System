// Reusable detail card for a single milestone.
//
// Renders the per-step fields the user/admin can attach:
//
//   • recruiter_message  — what the recruiter sent that triggered
//                          this step.
//   • reply_message      — the user's reply at this step.
//   • interview_link     — clickable URL (Zoom / Teams / HackerRank).
//   • ai_interview_detail— free-form notes specific to AI-driven steps
//                          (used when kind='ai_interview').
//
// The component is intentionally compact: a 2-column grid on md,
// single-column on mobile. When no fields are populated, the whole
// card is hidden (no empty section).
//
// Props:
//   milestone     : { kind, label, recruiter_message, reply_message,
//                     interview_link, ai_interview_detail }
//   index         : 0-based position (used purely for display)
//   accentClass   : optional className for the wrapper border

import { cn } from '@/lib/utils';
import { MessageSquare, Mail, Link2, Sparkles } from 'lucide-react';

export function MilestoneDetailCard({ milestone, index = 0, accentClass }) {
    if (!milestone) return null;

    const {
        kind,
        label,
        recruiter_message,
        reply_message,
        interview_link,
        ai_interview_detail
    } = milestone;

    const fields = [
        recruiter_message && {
            key: 'recruiter_message',
            Icon: Mail,
            label: 'Recruiter message',
            tone: 'amber',
            content: (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {recruiter_message}
                </p>
            )
        },
        reply_message && {
            key: 'reply_message',
            Icon: MessageSquare,
            label: 'Your reply',
            tone: 'sky',
            content: (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {reply_message}
                </p>
            )
        },
        interview_link && {
            key: 'interview_link',
            Icon: Link2,
            label: 'Interview link',
            tone: 'emerald',
            content: (
                <a
                    href={interview_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary underline-offset-2 hover:underline break-all"
                >
                    {interview_link}
                </a>
            )
        },
        kind === 'ai_interview' && ai_interview_detail && {
            key: 'ai_interview_detail',
            Icon: Sparkles,
            label: 'AI interview detail',
            tone: 'sky',
            content: (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {ai_interview_detail}
                </p>
            )
        }
    ].filter(Boolean);

    if (fields.length === 0) return null;

    const TONE_RING = {
        amber:    'bg-amber-500/10 border-amber-500/30 text-amber-300',
        sky:      'bg-sky-500/10 border-sky-500/30 text-sky-300',
        emerald:  'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
        violet:   'bg-violet-500/10 border-violet-500/30 text-violet-300'
    };
    const TONE_LABEL = {
        amber:    'text-amber-300',
        sky:      'text-sky-300',
        emerald:  'text-emerald-300',
        violet:   'text-violet-300'
    };

    return (
        <div
            className={cn(
                'rounded-md border p-3 space-y-2 bg-card/40',
                accentClass || 'border-border'
            )}
        >
            <div className="flex items-center gap-2 text-xs">
                <span className="rounded-full bg-muted px-2 py-0.5 uppercase tracking-wider text-muted-foreground">
                    Step {index + 1}
                </span>
                <span className="font-medium text-foreground">
                    {label || (kind || 'milestone').replace(/_/g, ' ')}
                </span>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {fields.map(({ key, Icon, label: fieldLabel, tone, content }) => (
                    <div
                        key={key}
                        className={cn(
                            'rounded-md border px-3 py-2',
                            TONE_RING[tone]
                        )}
                    >
                        <div className={cn(
                            'flex items-center gap-1.5 text-[10px] uppercase tracking-wider mb-1',
                            TONE_LABEL[tone]
                        )}>
                            <Icon className="h-3 w-3" />
                            {fieldLabel}
                        </div>
                        {content}
                    </div>
                ))}
            </div>
        </div>
    );
}
