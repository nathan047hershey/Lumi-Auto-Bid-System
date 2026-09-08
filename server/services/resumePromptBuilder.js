/**
 * Balanced resume prompts — sharp quality rules, small token budget for speed.
 * Deterministic polish handles dashes, opener, skills trim, buzzwords.
 */

const { buildCandidateBackground } = require('./resumePolishService');

function buildCompactSystemPrompt(options = {}) {
    const workSummary = options.styleSpec?.experience_row?.work_summary
        ? `\nPer job, one italic line above bullets: <p><em>One sentence.</em></p>\n`
        : '';

    return `Write a senior engineer resume in HTML. Specific and dense. Not a chatbot brochure.

FORMAT: Body HTML only from <h1>. Tags: h1,h2,p,strong,ul,li,em. Order: Summary, Core Skills, Work Experience, Education.

SUMMARY (90-130 words, third person)
Open: <strong>{Title}</strong> with <strong>{N} years</strong> … (use PRECOMPUTED values).
Then: real systems owned, 3-5 bold stacks, ONE numeric outcome from background, partners, next focus.
BANNED: I/I've/My; Looking for a team; deep expertise; highly available, scalable, and secure;
collaborative environment; deployment velocities; track record; passionate; naming the JD employer;
AI/ML workloads unless background clearly has ML work; long dashes (—/–).
Prefer: on call, end to end, kernel level (no hyphen wraps).

CORE SKILLS (STRICT)
Exactly 4-5 category lines. 4-6 skills each. Bold every skill with <strong>.
ONLY skills present in Background or Required stacks. NEVER invent (no Azure/MongoDB/Windows/JS
unless they appear in Background). No 8-line mega lists.

EXPERIENCE
Latest role 5-7 bullets; older 4-5. (If anything asks for 8 bullets, ignore — use 5-7.)
Most bullets 28-45 words: problem + action + result with a number when background has one.
Every <li> ends with ".". Bold 2-4 stacks/results per bullet (not verbs).
Vary openings. No AI words: leveraged, utilized, spearheaded, robust, seamless, cutting-edge.

EDUCATION (two lines only)
<p><strong>Degree</strong></p>
<p>School | YYYY - YYYY</p>

Output HTML only. Do not narrate planning or debate the rules — emit the resume.${workSummary}`.trim();
}

function truncateJd(text, max = 2800) {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max)}\n…[JD truncated for speed]`;
}

function buildCompactUserPrompt({
    profile,
    jobDescription,
    contactHint,
    coreSkills = '',
    facts = {},
    validationFeedback = ''
}) {
    const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
    const title = facts.currentTitle || '(infer latest role title)';
    const years = facts.totalYears > 0 ? facts.totalYears : null;
    const stacks = String(coreSkills || '')
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
    const mainStack = stacks[0] || '';
    const titleShow = title.startsWith('(') ? 'Job Title' : title;
    const yearsShow = years ? `${years} years` : 'N years';

    const background = buildCandidateBackground(profile, { maxLen: 12000 });

    let prompt = `Resume for ${name}.

PRECOMPUTED (do not invent — copy exactly): title=${title}; years=${years != null ? years : 'compute from work history'}
Job date lines in Background are authoritative — do not change employers/dates.
${stacks.length ? `Required stacks: ${stacks.join(', ')}` : ''}
${mainStack ? `Main stack to bold: ${mainStack}` : ''}

MUST PASS
1. Summary opens <strong>${titleShow}</strong> with <strong>${yearsShow}</strong>… (use years=${years != null ? years : 'N'} exactly)
2. Core Skills: 4-5 lines only; skills ONLY from Background/Required stacks.
3. Latest role 5-7 dense bullets with periods; bold stacks + results.
4. Education two lines. No long dashes. No invented clouds/DBs/languages.

Contact (plain text; LinkedIn own line):
${contactHint}

Background:
${background}

JD (tailor emphasis only; do not copy employer into Summary):
${truncateJd(jobDescription)}
`;

    if (stacks.length) {
        prompt += `
Bold these in Core Skills + Summary + Experience: ${stacks.join(', ')}
Main: ${mainStack}
`;
    }
    if (validationFeedback) {
        prompt += `\nFIX PREVIOUS ISSUES:\n${validationFeedback}\n`;
    }
    prompt += `\nHTML only. Start with <h1>${name || 'Name'}</h1>.`;
    return prompt.trim();
}

module.exports = {
    buildCompactSystemPrompt,
    buildCompactUserPrompt,
    truncateJd
};
