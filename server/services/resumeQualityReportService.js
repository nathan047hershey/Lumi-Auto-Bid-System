/**
 * Post-generate CV quality report — 4 passes that mirror the issues
 * we keep hitting in real DOCX/preview reviews:
 *   1) Structure & contact
 *   2) Summary voice (About Me)
 *   3) Experience depth
 *   4) Typography & education form
 *
 * Always returned to the client so the user can see what failed
 * without opening Word. Critical failures can also drive remakes.
 */

'use strict';

function stripTags(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractSectionHtml(html, aliases) {
    const body = String(html || '');
    const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
    const headings = [];
    let m;
    while ((m = h2Re.exec(body)) !== null) {
        headings.push({
            index: m.index,
            end: h2Re.lastIndex,
            label: stripTags(m[1]).toLowerCase()
        });
    }
    const want = (aliases || []).map((a) => String(a).toLowerCase());
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        if (!want.some((a) => h.label === a || h.label.includes(a))) continue;
        const next = headings[i + 1];
        return body.slice(h.end, next ? next.index : body.length);
    }
    return '';
}

function addCheck(checks, issues, passId, id, pass, message, severity = 'warn') {
    const row = { pass_id: passId, id, pass: !!pass, message, severity };
    checks.push(row);
    if (!pass) issues.push({ ...row });
}

const JUNIOR_SUMMARY_PATTERNS = [
    { id: 'first_person', re: /\b(I build|I spend|I've|I have|My focus|I'm a)\b/i, msg: 'Summary uses first person ("I…") — rewrite in third person / ownership voice' },
    { id: 'strong_background', re: /\bStrong background in\b/i, msg: 'Summary contains banned filler: "Strong background in…"' },
    { id: 'looking_for_team', re: /\bLooking for a (team|role|company)\b/i, msg: 'Summary ends with banned "Looking for a team/role…" closer' },
    { id: 'quippy_3am', re: /\b(3\s*AM|without pages|teams actually rely on|boring reliability)\b/i, msg: 'Summary has quippy junior-AI filler (3 AM / without pages / etc.)' },
    { id: 'focused_on', re: /\bFocused on\b/i, msg: 'Summary contains banned filler: "Focused on…"' },
    { id: 'track_record', re: /\b(proven )?track record\b/i, msg: 'Summary contains banned filler: "track record"' },
    { id: 'passionate_opener', re: /\bPassionate\b/i, msg: 'Summary contains banned filler: "Passionate…"' }
];

const TECHISH_TITLE = /^(python|java|go|golang|aws|linux|kubernetes|docker|react|node|sql|postgres|mysql|ansible|terraform|ci\/cd|rest|api)$/i;

/**
 * @param {string} html
 * @param {{ profile?: object, jobDescription?: string, coreSkills?: string }} [context]
 */
function buildResumeQualityReport(html, context = {}) {
    const body = String(html || '').trim();
    const profile = context.profile || {};
    const checks = [];
    const issues = [];
    const passes = [];

    // ── Pass 1: Structure & contact ─────────────────────────────
    const p1 = { id: 1, name: 'Structure & contact', checks: [] };
    const summaryHtml = extractSectionHtml(body, ['summary', 'professional summary', 'profile']);
    const skillsHtml = extractSectionHtml(body, ['core skills', 'skills', 'technical skills']);
    const expHtml = extractSectionHtml(body, ['work experience', 'professional experience', 'experience']);
    const eduHtml = extractSectionHtml(body, ['education', 'academic background', 'qualifications']);

    addCheck(p1.checks, issues, 1, 'has_summary', summaryHtml.length > 40, 'Summary section present');
    addCheck(p1.checks, issues, 1, 'has_skills', skillsHtml.length > 20, 'Core Skills section present');
    addCheck(p1.checks, issues, 1, 'has_experience', expHtml.length > 40, 'Work Experience section present');
    addCheck(p1.checks, issues, 1, 'has_education', eduHtml.length > 10, 'Education section present');

    const hasEmailLink = /<a\b[^>]*href=["']mailto:/i.test(body);
    const hasUrlLink = /<a\b[^>]*href=["']https?:\/\//i.test(body);
    if (profile.email) {
        addCheck(
            p1.checks, issues, 1, 'email_hyperlink', hasEmailLink,
            hasEmailLink ? 'Email is a mailto hyperlink' : 'Email is not a clickable mailto hyperlink',
            'warn'
        );
    }
    if (profile.linkedin_url) {
        addCheck(
            p1.checks, issues, 1, 'linkedin_hyperlink', hasUrlLink,
            hasUrlLink ? 'LinkedIn/profile URL is a hyperlink' : 'LinkedIn URL is not a clickable hyperlink',
            'warn'
        );
    }
    passes.push(p1);
    checks.push(...p1.checks);

    // ── Pass 2: Summary voice ───────────────────────────────────
    const p2 = { id: 2, name: 'Summary voice', checks: [] };
    const summaryText = stripTags(summaryHtml);
    const summaryWords = summaryText ? summaryText.split(/\s+/).filter(Boolean).length : 0;
    addCheck(
        p2.checks, issues, 2, 'summary_depth', summaryWords >= 80,
        summaryWords >= 80
            ? `Summary depth OK (${summaryWords} words)`
            : `Summary too thin (${summaryWords} words) — need ~90–140 About Me words`,
        'critical'
    );
    for (const rule of JUNIOR_SUMMARY_PATTERNS) {
        const hit = rule.re.test(summaryText);
        addCheck(p2.checks, issues, 2, `summary_${rule.id}`, !hit, hit ? rule.msg : `Summary OK: no ${rule.id.replace(/_/g, ' ')}`, 'critical');
    }

    // Required opener: bold current title + bold total years in first sentence area
    const firstChunkHtml = summaryHtml.slice(0, Math.min(summaryHtml.length, 500));
    const boldSpans = [...firstChunkHtml.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].map((m) =>
        String(m[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    );
    const hasBoldYears = boldSpans.some((s) => /^\d+\+?\s*years?(?:\s+of\s+experience)?$/i.test(s));
    const hasBoldTitle = boldSpans.some((s) => {
        if (!s || s.length < 4 || s.length > 70) return false;
        if (/^\d/.test(s)) return false;
        if (TECHISH_TITLE.test(s)) return false;
        return /\b(engineer|developer|architect|administrator|sre|devops|manager|lead|analyst|scientist|specialist|consultant|director|principal|staff)\b/i.test(s)
            || /\b(sr\.?|senior|junior|staff|principal)\b/i.test(s);
    });
    addCheck(
        p2.checks, issues, 2, 'summary_bold_title', hasBoldTitle,
        hasBoldTitle
            ? 'Summary bolds current job title near the opener'
            : 'Summary must bold the current job title in the first sentence (e.g. <strong>Software Engineer</strong>)',
        'critical'
    );
    addCheck(
        p2.checks, issues, 2, 'summary_bold_years', hasBoldYears,
        hasBoldYears
            ? 'Summary bolds total experience years near the opener'
            : 'Summary must bold total years in the first sentence (e.g. <strong>12 years</strong>)',
        'critical'
    );

    passes.push(p2);
    checks.push(...p2.checks);

    // ── Pass 3: Experience depth ────────────────────────────────
    const p3 = { id: 3, name: 'Experience depth', checks: [] };
    const bullets = (expHtml.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || []).map((li) => stripTags(li));
    const dense = bullets.filter((t) => t.split(/\s+/).filter(Boolean).length >= 22);
    const missingPeriod = bullets.filter((t) => t && !/[.!?]"?$/.test(t.trim()));
    addCheck(
        p3.checks, issues, 3, 'bullet_count', bullets.length >= 8,
        bullets.length >= 8
            ? `Experience bullet count OK (${bullets.length})`
            : `Too few experience bullets (${bullets.length}) — aim for 5–7 on latest role, 4–5 on older`,
        'critical'
    );
    addCheck(
        p3.checks, issues, 3, 'bullet_density',
        bullets.length === 0 || dense.length >= Math.ceil(bullets.length * 0.7),
        dense.length >= Math.ceil((bullets.length || 1) * 0.7)
            ? `Bullet density OK (${dense.length}/${bullets.length || 0} substantive)`
            : `Bullets too thin (${dense.length}/${bullets.length} substantive) — most need problem + action + result`,
        'critical'
    );
    addCheck(
        p3.checks, issues, 3, 'bullet_periods',
        missingPeriod.length === 0,
        missingPeriod.length === 0
            ? 'All experience bullets end with punctuation'
            : `${missingPeriod.length} bullet(s) missing ending period`,
        'warn'
    );
    passes.push(p3);
    checks.push(...p3.checks);

    // ── Pass 4: Typography & education ──────────────────────────
    const p4 = { id: 4, name: 'Typography & education', checks: [] };
    // Broken hyphen: "e- commerce" / "kernel- level" (space after hyphen)
    const brokenHyphenRe = /[A-Za-z][\u00AD\u2010\u2011\-]\s+[A-Za-z]/g;
    const brokenHits = summaryText.match(brokenHyphenRe)
        || stripTags(body).match(brokenHyphenRe)
        || [];
    const uniqueBroken = [...new Set((brokenHits || []).map((s) => s.replace(/\s+/g, ' ')))].slice(0, 5);
    addCheck(
        p4.checks, issues, 4, 'hyphen_spacing',
        uniqueBroken.length === 0,
        uniqueBroken.length === 0
            ? 'No broken hyphen compounds (e- commerce / kernel- level)'
            : `Broken hyphen compounds found: ${uniqueBroken.join(', ')}`,
        'critical'
    );

    // Long dashes (em/en) are an AI tic — should already be stripped in pipeline
    const longDashRe = /[\u2012\u2013\u2014\u2015]|&mdash;|&ndash;/i;
    const hasLongDash = longDashRe.test(body);
    addCheck(
        p4.checks, issues, 4, 'no_long_dashes',
        !hasLongDash,
        hasLongDash
            ? 'Long dashes (— / –) found — replace with commas, periods, or ASCII " - " in date ranges'
            : 'No em/en long dashes in CV body',
        'critical'
    );

    const eduHasDegreeLine = /<p[^>]*>\s*<strong>[\s\S]*?<\/strong>\s*<\/p>/i.test(eduHtml);
    const eduHasMeta = /edu-meta/i.test(eduHtml)
        || (/<p[^>]*>[^<]*\|[^<]*(?:19|20)\d{2}/i.test(eduHtml) && !/<strong>[\s\S]*\|[\s\S]*\|[\s\S]*<\/strong>/i.test(eduHtml));
    const eduSinglePipeBold = /<strong>\s*[^<|]+\|[^<|]+\|[^<]*\d{4}[^<]*<\/strong>/i.test(eduHtml);
    addCheck(
        p4.checks, issues, 4, 'education_two_line',
        eduHtml.length === 0 || (eduHasDegreeLine && (eduHasMeta || !eduSinglePipeBold) && !eduSinglePipeBold),
        eduSinglePipeBold
            ? 'Education still one bold pipe line (Degree | School | Years) — should be two lines'
            : (eduHasDegreeLine
                ? 'Education form OK (degree line + school/years)'
                : 'Education form missing or incomplete'),
        'critical'
    );

    // Prefer nowrap protection or NBH present for remaining hyphen compounds in summary
    const rawHyphenLeft = /\b[A-Za-z]+-[A-Za-z]+\b/.test(summaryHtml.replace(/<span class="nbh">[\s\S]*?<\/span>/gi, ''));
    const hasNbhSpans = /class=["'][^"']*nbh/.test(summaryHtml) || /\u2011/.test(summaryHtml);
    addCheck(
        p4.checks, issues, 4, 'hyphen_protected',
        !rawHyphenLeft || hasNbhSpans,
        hasNbhSpans || !rawHyphenLeft
            ? 'Hyphen compounds protected (nowrap / non-breaking hyphen)'
            : 'Hyphen compounds still unprotected ASCII hyphens in Summary (may wrap mid-word in Word)',
        'warn'
    );

    passes.push(p4);
    checks.push(...p4.checks);

    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    const warnIssues = issues.filter((i) => i.severity !== 'critical');
    const total = checks.length || 1;
    const passedCount = checks.filter((c) => c.pass).length;
    const score = Math.round((passedCount / total) * 100);
    let grade = 'A';
    if (score < 95) grade = 'B';
    if (score < 85) grade = 'C';
    if (score < 70) grade = 'D';
    if (criticalIssues.length >= 3) grade = 'D';

    const passSummaries = passes.map((p) => {
        const failed = p.checks.filter((c) => !c.pass);
        return {
            id: p.id,
            name: p.name,
            pass: failed.length === 0,
            passed: p.checks.filter((c) => c.pass).length,
            total: p.checks.length,
            issues: failed.map((c) => c.message)
        };
    });

    return {
        pass: criticalIssues.length === 0,
        score,
        grade,
        checks,
        issues,
        critical_count: criticalIssues.length,
        warn_count: warnIssues.length,
        passes: passSummaries,
        summary: criticalIssues.length === 0 && warnIssues.length === 0
            ? `Quality OK — grade ${grade} (${score}%) across 4 checks`
            : `Grade ${grade} (${score}%) — ${criticalIssues.length} critical, ${warnIssues.length} warning(s) across 4 checks`
    };
}

function buildQualityRemakeFeedback(report) {
    if (!report || report.pass) return null;
    const lines = [
        '=== FIX THESE CV QUALITY ISSUES (4-pass audit) ===',
        report.summary,
        ...report.issues.slice(0, 12).map((i) => `- [Pass ${i.pass_id}/${i.severity}] ${i.message}`),
        '',
        'Rules while fixing:',
        '- Summary: third person, ~90–140 words; FIRST sentence MUST bold current job title + total years (e.g. <strong>Software Engineer</strong> with <strong>12 years</strong>…). No "I build", no "Looking for a team".',
        '- Prefer open compounds: "on call", "kernel level", "application layer", "ecommerce" — avoid hyphen wraps.',
        '- NO long dashes (— or –). Use commas, periods, colons, or ASCII " - " only in date ranges.',
        '- Education MUST be two lines: <p><strong>Degree</strong></p> then <p>School | YYYY - YYYY</p>.',
        '- Experience: dense bullets (problem + action + result), 5–7 on latest role.'
    ];
    return lines.join('\n');
}

module.exports = {
    buildResumeQualityReport,
    buildQualityRemakeFeedback,
    extractSectionHtml
};
