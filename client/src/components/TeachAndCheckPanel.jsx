import { useEffect, useState } from 'react';
import { userAPI } from '@/api';
import { Button } from '@/components/ui/button';

function formatMatch(m) {
    if (!m) return null;
    if (m.hit) {
        return `Match — would answer “${m.answer}” (${m.kind || 'taught'}, score ${Number(m.score || 0).toFixed(2)})`;
    }
    return `No match yet (${m.reason || 'miss'})`;
}

export default function TeachAndCheckPanel({
    compact = false,
    seedQuestion = '',
    seedAnswer = '',
    onTaught
}) {
    const [question, setQuestion] = useState(seedQuestion);
    const [answer, setAnswer] = useState(seedAnswer);
    const [instruction, setInstruction] = useState('');
    const [checkQuestion, setCheckQuestion] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (seedQuestion) setQuestion(seedQuestion);
        if (seedAnswer) setAnswer(seedAnswer);
    }, [seedQuestion, seedAnswer]);

    const run = async (save, updateAll = false, checkSites = false) => {
        const q = question.trim();
        const a = answer.trim();
        const instr = instruction.trim();
        if (save && !q && !instr) {
            setError('Enter the course question, or an instruction like “always pick Yes for relocation”.');
            return;
        }
        if (!save && !checkSites && !checkQuestion.trim() && !q) {
            setError('Enter a wording to check again.');
            return;
        }
        if (checkSites && !q && !instr) {
            setError('Enter a question first, then Check all sites.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const { data } = await userAPI.teachQuestionMemory({
                question: q,
                answer: a,
                instruction: instr,
                check_question: checkQuestion.trim(),
                save,
                update_all: !!updateAll,
                check_all_sites: !!checkSites
            });
            setResult(data);
            if (data.taught?.question && !q) setQuestion(data.taught.question);
            if (data.taught?.answer && !a) setAnswer(data.taught.answer);
            if (save && typeof onTaught === 'function') onTaught(data);
        } catch (err) {
            setResult(null);
            setError(err.response?.data?.error || err.message || 'Teach failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
            <p className={compact ? 'text-[11px] text-muted-foreground' : 'text-xs text-muted-foreground'}>
                All = check every site, save, rematch, and update every profile. Or run the steps one by one.
            </p>
            <textarea
                className="min-h-[44px] w-full rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]"
                placeholder="Question from the course (e.g. Will you require visa sponsorship?)"
                value={question}
                disabled={busy}
                onChange={(e) => setQuestion(e.target.value)}
            />
            <input
                className="h-7 w-full rounded-md border border-border/60 bg-background/80 px-2 text-[11px]"
                placeholder="Answer to use next time (e.g. No)"
                value={answer}
                disabled={busy}
                onChange={(e) => setAnswer(e.target.value)}
            />
            <input
                className="h-7 w-full rounded-md border border-border/60 bg-background/80 px-2 text-[11px]"
                placeholder="Or instruction: always pick No for sponsorship"
                value={instruction}
                disabled={busy}
                onChange={(e) => setInstruction(e.target.value)}
            />
            <input
                className="h-7 w-full rounded-md border border-border/60 bg-background/80 px-2 text-[11px]"
                placeholder="Check again with other wording (optional)"
                value={checkQuestion}
                disabled={busy}
                onChange={(e) => setCheckQuestion(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={busy || (!question.trim() && !instruction.trim()) || (!answer.trim() && !instruction.trim())}
                    onClick={() => run(true, true, true)}
                >
                    {busy ? 'Working…' : 'All'}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy || (!question.trim() && !instruction.trim())}
                    onClick={() => run(false, false, true)}
                >
                    Check all sites
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={() => run(true, false, true)}
                >
                    Save & check
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={() => run(false)}
                >
                    Check again
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy || !question.trim() || !answer.trim()}
                    onClick={() => run(true, true, true)}
                >
                    Update all
                </Button>
            </div>
            {error ? (
                <p className="text-[11px] text-destructive">{error}</p>
            ) : null}
            {result?.ok ? (
                <div className="space-y-0.5 rounded-md border border-border/50 bg-background/50 px-2 py-1.5 text-[11px]">
                    {result.saved ? (
                        <p className={result.learned ? 'text-emerald-300' : 'text-amber-200'}>
                            {result.learned
                                ? `Saved — next time this question hits “${result.match?.answer || result.taught?.answer}”.`
                                : 'Saved, but the rematch did not hit yet. Try Check again with closer wording.'}
                        </p>
                    ) : null}
                    <p className="text-muted-foreground">{formatMatch(result.match)}</p>
                    {result.check_again ? (
                        <p className={result.check_ok ? 'text-emerald-300' : 'text-amber-200'}>
                            Check again: {formatMatch(result.check_again)}
                        </p>
                    ) : null}
                    {result.update_all ? (
                        <p className="text-sky-200">
                            Update all: {result.update_all.memory_updated || 0} memory row(s)
                            {result.update_all.field
                                ? ` · ${result.update_all.profiles_updated || 0} profile(s) (${result.update_all.field})`
                                : ''}
                        </p>
                    ) : null}
                    {result.sites ? (
                        <div className="space-y-0.5 pt-1">
                            <p className="text-foreground/90">
                                Sites: {result.sites.sites_ok || 0}/{result.sites.site_count || 0} would hit
                                {result.sites.site_count === 0 ? ' — no bid sites yet' : ''}
                            </p>
                            {(result.sites.sites || []).slice(0, 16).map((s) => (
                                <p
                                    key={s.host}
                                    className={s.ok ? 'text-emerald-300' : 'text-amber-200'}
                                >
                                    {s.ok ? '✓' : '✗'} {s.host}
                                    {s.course_count ? ` · ${s.course_count} course(s)` : ''}
                                    {s.ok && s.checks?.find((c) => c.agrees)?.answer
                                        ? ` → ${s.checks.find((c) => c.agrees).answer}`
                                        : ''}
                                </p>
                            ))}
                            {(result.sites.sites || []).length > 16 ? (
                                <p className="text-muted-foreground">
                                    +{(result.sites.sites || []).length - 16} more
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
