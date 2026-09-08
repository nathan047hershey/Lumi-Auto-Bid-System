/**
 * Draft CV validation — main tech stack alignment + basic structure.
 * After draft generation: if stack checks pass → finalize DOCX; else remake draft.
 */

/** Maps UI stack labels to searchable tokens in resume HTML. */
const STACK_PROFILES = [
    { label: '.NET', keys: ['.net', 'dotnet', 'c#', 'csharp', 'asp.net', 'aspnet', 'entity framework', 'blazor', 'wcf'] },
    { label: 'Python', keys: ['python', 'django', 'flask', 'fastapi', 'pandas', 'numpy'] },
    { label: 'Java', keys: ['java', 'spring boot', 'spring', 'hibernate', 'maven', 'gradle', 'jvm'] },
    { label: 'Golang', keys: ['golang', 'golang.org', 'go developer', 'go engineer'] },
    { label: 'Ruby on Rails', keys: ['ruby on rails', 'rails', 'ruby'] },
    { label: 'Node.js', keys: ['node.js', 'nodejs', 'node ', 'express', 'nestjs', 'npm'] },
    { label: 'React frontend', keys: ['react', 'redux', 'next.js', 'nextjs', 'jsx', 'typescript', 'javascript'] },
    { label: 'Angular frontend', keys: ['angular', 'rxjs', 'typescript', 'ngrx'] }
];

const JD_STACK_HINTS = [
    { label: '.NET', patterns: [/\.net\b/i, /\bc#\b/i, /\bcsharp\b/i, /\basp\.net\b/i] },
    { label: 'Python', patterns: [/\bpython\b/i, /\bdjango\b/i, /\bflask\b/i] },
    { label: 'Java', patterns: [/\bjava\b/i, /\bspring boot\b/i, /\bspring\b/i] },
    { label: 'Golang', patterns: [/\bgolang\b/i, /\bgo developer\b/i, /\bgo engineer\b/i] },
    { label: 'Ruby on Rails', patterns: [/\bruby on rails\b/i, /\brails\b/i, /\bruby\b/i] },
    { label: 'Node.js', patterns: [/\bnode\.js\b/i, /\bnodejs\b/i, /\bexpress\b/i] },
    // React / frontend: require react or next.js — not bare "frontend" (false positives).
    { label: 'React frontend', patterns: [/\breact\b/i, /\bnext\.js\b/i, /\bnextjs\b/i] },
    { label: 'Angular frontend', patterns: [/\bangular\b/i] }
];

function stripTags(html) {
    return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseCoreSkills(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
    return String(input)
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function inferStacksFromJobDescription(jobDescription) {
    const jd = String(jobDescription || '');
    const found = [];
    for (const hint of JD_STACK_HINTS) {
        if (hint.patterns.some((re) => re.test(jd))) {
            found.push(hint.label);
        }
    }
    return found.slice(0, 3);
}

function resolveRequiredStacks(coreSkillsInput, jobDescription) {
    const fromForm = parseCoreSkills(coreSkillsInput);
    if (fromForm.length > 0) return fromForm;
    return inferStacksFromJobDescription(jobDescription);
}

function findStackProfile(label) {
    const norm = String(label || '').trim().toLowerCase();
    if (!norm) return null;
    const exact = STACK_PROFILES.find((p) => p.label.toLowerCase() === norm);
    if (exact) return exact;
    // Alias: "React" → React frontend, "Node" → Node.js, etc.
    return STACK_PROFILES.find((p) =>
        p.keys.some((k) => {
            const key = k.trim().toLowerCase();
            return key && (norm === key || norm.includes(key) || key.includes(norm));
        })
    ) || null;
}

function textContainsStack(text, stackLabel) {
    const profile = findStackProfile(stackLabel);
    const lower = String(text || '').toLowerCase();
    const label = String(stackLabel || '').toLowerCase();
    if (!profile) {
        if (lower.includes(label)) return true;
        if (label === 'postgres' && lower.includes('postgresql')) return true;
        if (label === 'postgresql' && lower.includes('postgres')) return true;
        return false;
    }
    return profile.keys.some((k) => lower.includes(k.trim()));
}

function htmlHasBoldStack(html, stackLabel) {
    const profile = findStackProfile(stackLabel);
    const keys = profile ? profile.keys : [String(stackLabel).toLowerCase()];
    // Also accept Postgres ↔ PostgreSQL
    const extras = [];
    const lowerLabel = String(stackLabel || '').toLowerCase();
    if (lowerLabel === 'postgres') extras.push('postgresql');
    if (lowerLabel === 'postgresql') extras.push('postgres');
    for (const key of [...keys, ...extras]) {
        const token = key.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!token) continue;
        const re = new RegExp(`<strong[^>]*>[^<]*${token}`, 'i');
        if (re.test(html)) return true;
    }
    return false;
}

function extractSectionHtml(html, sectionKeys) {
    // Match the section title ONLY inside the <h2>…</h2> tag.
    // A loose [\s\S]*? across the document falsely matched the word
    // "experience" inside the Summary paragraph and then treated Core Skills
    // as the Work Experience body (0 bullets).
    const keys = sectionKeys
        .map((k) => String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .filter(Boolean)
        .join('|');
    if (!keys) return '';
    const re = new RegExp(
        `<h2\\b[^>]*>(?:(?!<\\/h2>)[\\s\\S])*?(?:${keys})(?:(?!<\\/h2>)[\\s\\S])*?<\\/h2>([\\s\\S]*?)(?=<h2\\b|$)`,
        'i'
    );
    const m = String(html || '').match(re);
    return m ? m[1] : '';
}

function countBulletsWithStack(html, stackLabel) {
    const expHtml = extractSectionHtml(html, ['work experience', 'professional experience', 'experience']);
    const bullets = expHtml.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return bullets.filter((li) => textContainsStack(li, stackLabel)).length;
}

function countBulletsWithBoldStack(html, stackLabel) {
    const expHtml = extractSectionHtml(html, ['work experience', 'professional experience', 'experience']);
    const bullets = expHtml.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return bullets.filter((li) => htmlHasBoldStack(li, stackLabel)).length;
}

/**
 * @returns {{ pass: boolean, issues: string[], checks: Array<{ id: string, pass: boolean, message: string }>, required_stacks: string[], primary_stack: string|null }}
 */
function validateResumeHtml(html, context = {}) {
    const issues = [];
    const checks = [];
    const body = (html || '').trim();

    const add = (id, pass, message) => {
        checks.push({ id, pass, message });
        if (!pass) issues.push(message);
    };

    const requiredStacks = resolveRequiredStacks(context.coreSkills, context.jobDescription);
    const primaryStack = requiredStacks[0] || null;

    add('non_empty', body.length > 100, 'Resume HTML is empty or too short');
    add('has_h1', /<h1[\s>]/i.test(body), 'Missing candidate name (<h1>)');

    const skillsHtml = extractSectionHtml(body, ['core skills', 'skills', 'technical skills']);
    add('has_skills_section', skillsHtml.length > 0, 'Missing Core Skills section');

    const summaryHtml = extractSectionHtml(body, ['summary']);
    add('has_summary_section', summaryHtml.length > 0, 'Missing Summary section');
    const summaryWords = stripTags(summaryHtml).split(/\s+/).filter(Boolean).length;
    add(
        'summary_about_me_depth',
        summaryWords >= 80,
        summaryWords >= 80
            ? `Summary About Me depth OK (${summaryWords} words)`
            : `Summary is too thin (${summaryWords} words) — expand to an About Me of ~90–140 words (open with bold current title + bold total years, then systems/stacks)`
    );

    const expHtml = extractSectionHtml(body, ['work experience', 'professional experience', 'experience']);
    add('has_experience_section', expHtml.length > 0, 'Missing Work Experience section');

    const expBullets = (expHtml.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []).map((li) => stripTags(li));
    const denseBullets = expBullets.filter((t) => t.split(/\s+/).filter(Boolean).length >= 22);
    add(
        'experience_bullet_count',
        expBullets.length >= 8,
        expBullets.length >= 8
            ? `Experience bullet count OK (${expBullets.length})`
            : `Experience needs more bullets (found ${expBullets.length}; aim for 5–7 on the latest role and 4–5 on older roles)`
    );
    add(
        'experience_bullet_density',
        expBullets.length === 0 || denseBullets.length >= Math.ceil(expBullets.length * 0.7),
        denseBullets.length >= Math.ceil((expBullets.length || 1) * 0.7)
            ? `Experience bullet density OK (${denseBullets.length}/${expBullets.length} dense)`
            : `Experience bullets are too thin (${denseBullets.length}/${expBullets.length} are substantive) — most bullets must be ~28–50 words with problem + action + result`
    );

    if (requiredStacks.length === 0) {
        add(
            'stack_selected',
            false,
            'Select at least one tech stack for this job (or include stack keywords in the job description)'
        );
    } else {
        add(
            'stack_selected',
            true,
            `Required stack(s): ${requiredStacks.join(', ')}`
        );

        for (const stack of requiredStacks) {
            const slug = stack.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

            add(
                `stack_${slug}_in_skills`,
                textContainsStack(skillsHtml, stack),
                `Core Skills must include ${stack}`
            );

            add(
                `stack_${slug}_bold_skills`,
                htmlHasBoldStack(skillsHtml, stack),
                `${stack} must be bold in Core Skills (<strong>)`
            );
        }

        if (primaryStack) {
            const slug = primaryStack.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

            add(
                `primary_${slug}_bold_summary`,
                htmlHasBoldStack(summaryHtml, primaryStack),
                `Main stack ${primaryStack} must be bold in Summary`
            );

            const expMentions = countBulletsWithStack(body, primaryStack);
            add(
                `primary_${slug}_in_experience`,
                expMentions >= 2,
                expMentions >= 2
                    ? `Main stack ${primaryStack} appears in ${expMentions} experience bullets`
                    : `Main stack ${primaryStack} must appear in at least 2 experience bullets (found ${expMentions})`
            );

            const expBold = countBulletsWithBoldStack(body, primaryStack);
            add(
                `primary_${slug}_bold_experience`,
                expBold >= 1,
                expBold >= 1
                    ? `Main stack ${primaryStack} is bold in experience bullets`
                    : `Main stack ${primaryStack} must be bold in at least 1 experience bullet`
            );
        }

        for (const stack of requiredStacks.slice(1)) {
            const slug = stack.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
            const expMentions = countBulletsWithStack(body, stack);
            add(
                `stack_${slug}_in_experience`,
                expMentions >= 1,
                expMentions >= 1
                    ? `${stack} appears in experience`
                    : `${stack} must appear in at least 1 experience bullet`
            );
        }
    }

    return {
        pass: issues.length === 0,
        issues,
        checks,
        required_stacks: requiredStacks,
        primary_stack: primaryStack
    };
}

function buildStackValidationFeedback(validation) {
    if (!validation?.issues?.length) return null;
    const stacks = validation.required_stacks?.length
        ? `Target stack(s): ${validation.required_stacks.join(', ')}`
        : '';
    const primary = validation.primary_stack
        ? `Main stack: ${validation.primary_stack} — must be bold in Summary, listed bold in Core Skills, and in 2+ experience bullets with <strong>.`
        : '';
    return [
        stacks,
        primary,
        'Fix every issue below in the next draft:',
        ...validation.issues.map((issue) => `- ${issue}`),
        'Put each missing stack as literal text inside Experience <li> bullets. Example:',
        '<li>Shipped checkout in <strong>React</strong> and TypeScript on Node.js services after latency complaints; p95 fell from ~800ms to ~150ms.</li>',
        'If Summary is thin: expand to ~90–140 words; FIRST sentence MUST bold current job title + total years (e.g. <strong>Software Engineer</strong> with <strong>12 years</strong>…), then systems/stacks.',
        'If Experience bullets are thin: rewrite most bullets to 28–50 words with problem + action + result; recent role 5–7 bullets.'
    ].filter(Boolean).join('\n');
}

module.exports = {
    validateResumeHtml,
    parseCoreSkills,
    resolveRequiredStacks,
    buildStackValidationFeedback
};
