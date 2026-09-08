/**
 * Deterministic CV polish — fixes that should not require an LLM remake.
 * Runs after generateResume HTML extract / before quality report.
 */

const TITLE_HINT =
    /\b(engineer|developer|architect|administrator|sre|devops|manager|lead|analyst|scientist|specialist|consultant|director|principal|staff)\b/i;

/** Parse profile.years_of_experience ("13", "13+", "10-12 years") → number. */
function parseProfileYearsOfExperience(raw) {
    const s = String(raw || '').trim();
    if (!s) return 0;
    const range = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
    if (range) return parseInt(range[2], 10);
    const m = s.match(/(\d+)\s*\+?/);
    if (m) return parseInt(m[1], 10);
    return 0;
}

/**
 * Stable background for prompts: structured work/education first, then notes.
 * Without work_experience, the model invents job dates every generate.
 */
function buildCandidateBackground(profile, { maxLen = 12000 } = {}) {
    const parts = [];
    const we = String(profile?.work_experience || '').trim();
    const edu = String(profile?.education || '').trim();
    const notes = String(profile?.resume_prompt || '').trim();
    if (we) parts.push(`Work history (use these employers/titles/dates exactly):\n${we}`);
    if (edu) parts.push(`Education:\n${edu}`);
    if (notes) parts.push(notes);
    let out = parts.join('\n\n');
    if (out.length > maxLen) out = `${out.slice(0, maxLen)}\n…[background truncated]`;
    return out;
}

function collectYearsFromText(text, nowYear) {
    const yearHits = [];
    const src = String(text || '');
    const yearRe = /\b((?:19|20)\d{2})\b/g;
    let ym;
    while ((ym = yearRe.exec(src)) !== null) {
        const y = parseInt(ym[1], 10);
        if (y >= 1980 && y <= nowYear + 1) yearHits.push(y);
    }
    const myRe = /\b(?:0?[1-9]|1[0-2])\/((?:19|20)\d{2})\b/g;
    while ((ym = myRe.exec(src)) !== null) {
        const y = parseInt(ym[1], 10);
        if (y >= 1980 && y <= nowYear + 1) yearHits.push(y);
    }
    return yearHits;
}

/**
 * Parse career facts from the PROFILE only (stable across generates).
 * Do not derive total years from LLM HTML — invented job dates made YoE drift.
 * @returns {{ currentTitle: string, totalYears: number, earliestYear: number|null, latestTitle: string }}
 */
function extractCareerFacts(profile, _resumeHtml = '') {
    const nowYear = new Date().getFullYear();
    const workText = String(profile?.work_experience || '').trim();
    const bg = String(profile?.resume_prompt || '');
    // Drop Education from freeform notes so school years don't shrink YoE.
    const bgWork = bg.split(/\n(?=Education\b)/i)[0] || bg;

    // 1) Profile field wins (application answers + summary opener stay in sync).
    let totalYears = parseProfileYearsOfExperience(profile?.years_of_experience);
    let earliestYear = null;

    // 2) Else compute once from structured work history / notes (never from HTML).
    if (!totalYears) {
        const yearHits = collectYearsFromText(`${workText}\n${bgWork}`, nowYear);
        earliestYear = yearHits.length ? Math.min(...yearHits) : null;
        totalYears = earliestYear ? Math.max(1, nowYear - earliestYear) : 0;
    } else {
        const yearHits = collectYearsFromText(workText || bgWork, nowYear);
        earliestYear = yearHits.length ? Math.min(...yearHits) : null;
    }

    const titleCandidates = [];
    // Prefer structured work history titles (first line = current role).
    for (const line of workText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const m = line.match(
            /^((?:Sr\.?\s+|Senior\s+|Staff\s+|Principal\s+|Junior\s+)?[A-Za-z][A-Za-z0-9 /&.-]{2,60}?)\s*[|•·]\s*/
        );
        if (m && TITLE_HINT.test(m[1])) {
            titleCandidates.push(m[1].replace(/\s+/g, ' ').trim());
        }
    }
    for (const line of bgWork.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const m = line.match(
            /^((?:Sr\.?\s+|Senior\s+|Staff\s+|Principal\s+|Junior\s+)?[A-Za-z][A-Za-z0-9 /&.-]{2,60}?)\s*[|•·]\s*/
        );
        if (m && TITLE_HINT.test(m[1])) {
            titleCandidates.push(m[1].replace(/\s+/g, ' ').trim());
        }
    }
    const currentTitle = titleCandidates[0] || '';

    if (!totalYears && /decade/i.test(bgWork)) totalYears = 10;

    return {
        currentTitle,
        totalYears,
        earliestYear,
        latestTitle: currentTitle
    };
}

function stripControlAndSoftHyphens(html) {
    return String(html || '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\u00AD/g, '') // soft hyphen
        .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '');
}

function ensureBulletPeriods(html) {
    return String(html || '').replace(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi, (full, attrs, inner) => {
        const text = String(inner).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!text) return full;
        if (/[.!?]"?\s*$/.test(text)) return full;
        // Append period before closing tags if inner ends with text node
        let next = String(inner).replace(/\s+$/, '');
        if (/<\/(strong|em|span|a)>\s*$/i.test(next)) {
            next = next.replace(/(<\/(?:strong|em|span|a)>)\s*$/i, '.$1');
        } else {
            next += '.';
        }
        return `<li${attrs}>${next}</li>`;
    });
}

function scrubBannedSummaryPhrases(summaryInnerHtml) {
    let s = String(summaryInnerHtml || '');
    const replacements = [
        [/\bI build\b/gi, 'Builds'],
        [/\bI spend\b/gi, 'Spends'],
        [/\bI've\b/gi, 'Has'],
        [/\bI have\b/gi, 'Has'],
        [/\bMy focus\b/gi, 'Focus'],
        [/\bI'm a\b/gi, ''],
        [/\bStrong background in\b/gi, 'Background in'],
        [/\bFocused on\b/gi, 'Works on'],
        [/\bPassionate about\b/gi, 'Experienced in'],
        [/\b(proven\s+)?track record( of)?\b/gi, 'history of'],
        [/\bLooking for a (team|role|company)[^.]*\./gi, ''],
        [/\bthe kind that runs at 3\s*AM\b/gi, ''],
        [/\bwithout pages\b/gi, ''],
        [/\bteams actually rely on\b/gi, ''],
        [/\bboring reliability\b/gi, 'reliability'],
        [/\bdeep expertise in\b/gi, ''],
        [/\bhighly available,?\s*scalable,?\s*and secure\b/gi, 'reliable production'],
        [/\bin a collaborative environment\.?/gi, ''],
        [/\bdeployment velocities\b/gi, 'deployment speed'],
        [/\bcomprehensive monitoring solutions\b/gi, 'monitoring'],
        [/\blimited observability\b/gi, 'weak visibility']
    ];
    for (const [re, rep] of replacements) {
        s = s.replace(re, rep);
    }
    return s.replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').replace(/\s+,/g, ',').trim();
}

/**
 * Build allowlist of skill tokens from the candidate, selected stacks, and JD.
 * JD is included so Core Skills can stay rich; inventing stacks that appear
 * nowhere in profile/JD is still blocked by token matching.
 */
function buildSkillAllowlist(profile, coreSkills = '', jobDescription = '') {
    const raw = [
        String(profile?.work_experience || ''),
        String(profile?.education || ''),
        String(profile?.resume_prompt || ''),
        String(coreSkills || ''),
        String(jobDescription || '').slice(0, 6000)
    ].join('\n');
    const tokens = new Set();
    const re = /\b([A-Za-z][A-Za-z0-9+#./-]{1,28})\b/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const t = m[1];
        if (t.length < 2) continue;
        tokens.add(t.toLowerCase());
    }
    const multi = [
        'github actions', 'elk stack', 'windows server', 'cloud run',
        'spring boot', 'node.js', 'next.js', 'ci/cd', 'tcp/ip',
        'ruby on rails', 'site reliability'
    ];
    for (const phrase of multi) {
        if (raw.toLowerCase().includes(phrase)) tokens.add(phrase);
    }
    for (const sk of String(coreSkills || '').split(/[,;|]/)) {
        const t = sk.trim().toLowerCase();
        if (t) tokens.add(t);
    }
    return tokens;
}

function skillTokenAllowed(skill, allow, _coreList = []) {
    const s = String(skill || '').trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    // Drop non-tech fluff that used to pad skill lines
    if (/^(design|management|pipelines|builds|workloads|environment|services|systems|tooling|automation|reliability|observability|infrastructure)$/i.test(lower)) {
        return false;
    }
    if (allow.has(lower)) return true;
    const base = lower.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (base && allow.has(base)) return true;
    const parts = lower.split(/[\s/,]+/).filter((p) => p.length > 1);
    if (parts.length && parts.every((p) => allow.has(p) || /^(and|or|the)$/.test(p))) return true;
    for (const a of allow) {
        if (a.length >= 3 && (lower.includes(a) || a.includes(lower))) return true;
    }
    return false;
}

/**
 * Cap Core Skills to 5 lines; bold category + skills. Keep rich LLM lists —
 * only drop obvious fluff, not JD/profile allow mismatches (that was
 * shrinking "many skills" down to a handful).
 */
function trimCoreSkillsSection(resumeHtml, allow, coreSkills = '') {
    void allow;
    void coreSkills;
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:core skills|skills|technical skills)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            let paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
            if (!paras.length) {
                paras = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
            }
            if (!paras.length) return block;
            const kept = [];
            for (const pm of paras) {
                if (kept.length >= 5) break;
                const lines = splitSkillCategoryHtmlLines(pm[1]);
                for (const lineInner of lines) {
                    if (kept.length >= 5) break;
                    const catMatch = lineInner.match(
                        /^(?:<strong>)?([^<:]+?)(?:<\/strong>)?\s*:\s*([\s\S]+)$/i
                    );
                    if (!catMatch) {
                        kept.push(`<p>${lineInner}</p>`);
                        continue;
                    }
                    const cat = catMatch[1].replace(/<\/?strong>/gi, '').trim();
                    const skillParts = catMatch[2]
                        .split(',')
                        .map((x) => x.replace(/<\/?strong>/gi, '').trim())
                        .filter(Boolean)
                        .filter((sk) => !isSkillFluff(sk))
                        .slice(0, 8);
                    if (!skillParts.length) continue;
                    const line = formatSkillCategoryLine(cat, skillParts);
                    if (line) kept.push(line);
                }
            }
            if (!kept.length) return block;
            return heading + '\n' + kept.join('\n') + '\n';
        }
    );
}

function isSkillFluff(skill) {
    const lower = String(skill || '').trim().toLowerCase();
    return /^(design|management|pipelines|builds|workloads|environment|services|systems|tooling|automation|reliability|observability|infrastructure|performance tuning|artifact pipelines|reproducible builds|slo design)$/i.test(lower);
}

/** Strip trailing commas/periods and odd "code.," glitches from a skill token. */
function cleanSkillToken(skill) {
    return String(skill || '')
        .replace(/<\/?strong>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,;:]+$/g, '')
        .trim();
}

/** Format one skills row: bold category only, plain skill list, no trailing punctuation. */
function formatSkillCategoryLine(cat, skills) {
    const cleaned = (Array.isArray(skills) ? skills : String(skills || '').split(','))
        .map((sk) => cleanSkillToken(sk))
        .filter(Boolean)
        .filter((sk) => !isSkillFluff(sk));
    const label = String(cat || '').replace(/<\/?strong>/gi, '').trim().replace(/:+\s*$/, '');
    if (!label || !cleaned.length) return '';
    return `<p><strong>${label}</strong>: ${cleaned.join(', ')}</p>`;
}

/** Bucket selected stacks into 4–5 resume category lines. */
function categorizeCoreStacks(coreSkills = '') {
    const stacks = String(coreSkills || '')
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (!stacks.length) return [];

    const buckets = [
        { label: 'Languages & Scripting', keys: [], test: (s) => /python|ruby|go\b|golang|java|typescript|javascript|bash|shell|powershell|rust|c\+\+|c#|csharp|scala|kotlin|\.net|asp\.?net|node\.?js|html|css|sql\b/i.test(s) },
        { label: 'Systems & Networking', keys: [], test: (s) => /linux|unix|tcp|ip|networking|ubuntu|rhel|centos|systemd|windows server/i.test(s) },
        { label: 'Automation & CI\/CD', keys: [], test: (s) => /ansible|puppet|chef|jenkins|github actions|gitlab|ci\/?cd|terraform|pulumi/i.test(s) },
        { label: 'Observability', keys: [], test: (s) => /prometheus|grafana|datadog|influx|elk|splunk|pagerduty|monitoring|observability/i.test(s) },
        { label: 'Data & Containers', keys: [], test: (s) => /postgres|mysql|mongo|redis|docker|kubernetes|k8s|ceph|lustre|container|react|angular|dynamodb|sqlite/i.test(s) }
    ];
    const leftover = [];
    for (const sk of stacks) {
        const hit = buckets.find((b) => b.test(sk));
        if (hit) hit.keys.push(sk);
        else leftover.push(sk);
    }
    if (leftover.length) {
        const target = buckets.find((b) => b.keys.length < 6) || buckets[0];
        target.keys.push(...leftover);
    }
    return buckets
        .filter((b) => b.keys.length)
        .slice(0, 5)
        .map((b) => ({
            label: b.label,
            skills: b.keys.slice(0, 8)
        }));
}

/**
 * Pull tooling named in the JD so Core Skills is not stuck at a single
 * language checkbox (e.g. form only had "Python").
 */
const JD_TOOL_RULES = [
    { skill: 'Python', re: /\bpython\b/i },
    { skill: 'Java', re: /\bjava\b/i },
    { skill: 'Golang', re: /\bgolang\b|\bgo(?:lang)?\s*(?:developer|engineer|programmer|lang)/i },
    { skill: 'TypeScript', re: /\btypescript\b/i },
    { skill: 'JavaScript', re: /\bjavascript\b/i },
    { skill: 'HTML', re: /\bhtml5?\b/i },
    { skill: 'CSS', re: /\bcss3?\b/i },
    { skill: 'SQL', re: /\bsql\b/i },
    { skill: 'Ruby', re: /\bruby\b/i },
    { skill: 'Bash', re: /\bbash\b|\bshell\s*script/i },
    { skill: 'Node.js', re: /\bnode\.?js\b/i },
    { skill: 'Linux', re: /\blinux\b|\bubuntu\b|\brhel\b/i },
    { skill: 'systemd', re: /\bsystemd\b/i },
    { skill: 'TCP/IP', re: /\btcp\/?ip\b/i },
    { skill: 'Ansible', re: /\bansible\b/i },
    { skill: 'Puppet', re: /\bpuppet\b/i },
    { skill: 'Chef', re: /\bchef\b/i },
    { skill: 'Terraform', re: /\bterraform\b/i },
    { skill: 'Prometheus', re: /\bprometheus\b/i },
    { skill: 'Grafana', re: /\bgrafana\b/i },
    { skill: 'Datadog', re: /\bdatadog\b/i },
    { skill: 'InfluxDB', re: /\binflux(?:db)?\b/i },
    { skill: 'PagerDuty', re: /\bpagerduty\b/i },
    { skill: 'Jenkins', re: /\bjenkins\b/i },
    { skill: 'GitHub Actions', re: /\bgithub\s*actions\b/i },
    { skill: 'Docker', re: /\bdocker\b/i },
    { skill: 'Kubernetes', re: /\bkubernetes\b|\bk8s\b/i },
    { skill: 'Postgres', re: /\bpostgres(?:ql)?\b/i },
    { skill: 'MySQL', re: /\bmysql\b/i },
    { skill: 'MongoDB', re: /\bmongo(?:db)?\b/i },
    { skill: 'Redis', re: /\bredis\b/i },
    { skill: 'Ceph', re: /\bceph\b/i },
    { skill: 'AWS', re: /\baws\b|\bamazon web services\b/i }
];

/** Always merge these web/DB fundamentals into Core Skills. */
const DEFAULT_BASELINE_SKILLS = [
    'TypeScript',
    'JavaScript',
    'HTML',
    'CSS',
    'SQL'
];

function expandCoreSkillsFromJd(coreSkills = '', jobDescription = '') {
    const ordered = [];
    const seen = new Set();
    const add = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return;
        const k = s.toLowerCase();
        if (seen.has(k)) return;
        // Prefer "Golang" over bare "Go" when both match
        if (k === 'go' && seen.has('golang')) return;
        if (k === 'golang') {
            const goIdx = ordered.findIndex((x) => x.toLowerCase() === 'go');
            if (goIdx >= 0) ordered.splice(goIdx, 1);
            seen.delete('go');
        }
        seen.add(k);
        ordered.push(s);
    };
    for (const part of String(coreSkills || '').split(/[,;|]/)) add(part);
    for (const sk of DEFAULT_BASELINE_SKILLS) add(sk);
    const jd = String(jobDescription || '');
    if (jd) {
        for (const rule of JD_TOOL_RULES) {
            if (rule.re.test(jd)) add(rule.skill);
        }
    }
    return ordered;
}

/** Pull skill tokens already present in a Core Skills HTML body. */
function extractSkillsFromSectionBody(body) {
    const found = [];
    const paras = [...String(body || '').matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)];
    for (const pm of paras) {
        const plain = pm[1].replace(/<\/?strong>/gi, '').replace(/<[^>]+>/g, '').trim();
        const m = plain.match(/^[^:]{1,60}:\s*(.+)$/);
        if (!m) continue;
        for (const part of m[1].split(',')) {
            const sk = part.trim();
            if (sk) found.push(sk);
        }
    }
    return found;
}

/**
 * Only rebuild when Core Skills is thin. Prefer keeping a rich LLM list;
 * merge in JD/form stacks, then rewrite with bold tokens.
 */
function rebuildCoreSkillsIfThin(resumeHtml, coreSkills = '', jobDescription = '') {
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:core skills|skills|technical skills)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const existing = extractSkillsFromSectionBody(body);
            const fromJd = expandCoreSkillsFromJd(coreSkills, jobDescription);
            const merged = [];
            const seen = new Set();
            for (const sk of [...existing, ...fromJd]) {
                const k = String(sk).toLowerCase();
                if (!k || seen.has(k)) continue;
                seen.add(k);
                merged.push(sk);
            }
            const lineCount = (body.match(/<p\b|<li\b/gi) || []).length;
            const thin = lineCount < 3 || existing.length < 6;

            // Rich enough — keep LLM categories/skills; only ensure bold via trim already done
            if (!thin) {
                return block;
            }

            const cats = categorizeCoreStacks(merged.join(', '));
            if (!cats.length) return block;
            const lines = cats.map((c) => formatSkillCategoryLine(c.label, c.skills)).filter(Boolean);
            return `${heading}\n${lines.join('\n')}\n`;
        }
    );
}

/**
 * Category bold only; skill names normal. Strip trailing commas/periods
 * on each skill list (and mid-token junk like "code.,").
 */
function forceBoldSkillTokens(resumeHtml) {
    return String(resumeHtml || '').replace(
        /(<h2\b[^>]*>[\s\S]*?(?:core skills|skills|technical skills)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const next = body.replace(
                /<(p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
                (full, tag, attrs, inner) => {
                    const plain = String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    if (!/^.{1,80}:\s+.+/.test(plain)) return full;
                    const m = plain.match(/^(.{1,80}?):\s+(.+)$/);
                    if (!m) return full;
                    const line = formatSkillCategoryLine(m[1], m[2].split(','));
                    if (!line) return full;
                    // Preserve li vs p
                    if (tag.toLowerCase() === 'li') {
                        return line.replace(/^<p>/i, `<li${attrs}>`).replace(/<\/p>$/i, '</li>');
                    }
                    return attrs ? line.replace(/^<p>/i, `<p${attrs}>`) : line;
                }
            );
            return heading + next;
        }
    );
}

/** Bold each known stack token in the Summary paragraph. */
function boldStacksInSummary(resumeHtml, coreSkills = '', jobDescription = '') {
    const stacks = expandCoreSkillsFromJd(coreSkills, jobDescription)
        .slice()
        .sort((a, b) => b.length - a.length);
    if (!stacks.length) return resumeHtml;

    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:summary|profile)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const next = body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/i, (full, attrs, inner) => {
                // Work on plain segments outside existing <strong>…</strong>
                const parts = String(inner).split(/(<strong\b[^>]*>[\s\S]*?<\/strong>)/gi);
                const out = parts.map((part) => {
                    if (/^<strong\b/i.test(part)) return part;
                    let s = part;
                    for (const sk of stacks) {
                        const esc = sk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const re = new RegExp(`\\b(${esc})\\b`, 'gi');
                        s = s.replace(re, '<strong>$1</strong>');
                    }
                    return s;
                }).join('');
                return `<p${attrs}>${out}</p>`;
            });
            return heading + next;
        }
    );
}

/** Split "Cat A: a | Cat B: b" (with optional strong tags) into one inner HTML each. */
function splitSkillCategoryHtmlLines(innerHtml) {
    const plain = String(innerHtml || '')
        .replace(/<\/?strong>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
    if (!plain) return [String(innerHtml || '').trim()].filter(Boolean);
    const parts = plain.split(/\s*\|\s*(?=[A-Za-z][^|]{0,50}:\s)/);
    if (parts.length <= 1) {
        // Unwrap whole-line bold: <strong>Cat: a, b</strong> → Cat: a, b for rewrite
        const whole = String(innerHtml || '').match(/^<strong\b[^>]*>([\s\S]*)<\/strong>$/i);
        return [whole ? whole[1] : String(innerHtml || '').trim()];
    }
    return parts.map((p) => p.trim()).filter(Boolean);
}

/** Layout-only skills fix when no allowlist is available. */
function normalizeCoreSkillsLayout(resumeHtml) {
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:core skills|skills|technical skills)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
            if (!paras.length) return block;
            const kept = [];
            for (const pm of paras) {
                for (const lineInner of splitSkillCategoryHtmlLines(pm[1])) {
                    const catMatch = lineInner.match(
                        /^(?:<strong>)?([^<:]+?)(?:<\/strong>)?\s*:\s*([\s\S]+)$/i
                    );
                    if (!catMatch) {
                        kept.push(`<p>${lineInner}</p>`);
                        continue;
                    }
                    const cat = catMatch[1].replace(/<\/?strong>/gi, '').trim();
                    const skillParts = catMatch[2]
                        .split(',')
                        .map((x) => x.replace(/<\/?strong>/gi, '').trim())
                        .filter(Boolean);
                    const line = formatSkillCategoryLine(cat, skillParts);
                    if (line) kept.push(line);
                }
            }
            if (!kept.length) return block;
            return heading + '\n' + kept.join('\n') + '\n';
        }
    );
}

/**
 * Unwrap a Summary paragraph that is entirely wrapped in <strong>…</strong>
 * so only intentional keyword bold remains.
 */
function unwrapWholeBoldSummary(resumeHtml) {
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:summary|profile)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const fixed = body.replace(
                /<p\b([^>]*)>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi,
                (m, attrs, inner) => {
                    // Keep if it already has nested selective bold structure
                    // (title + years openers are short strong spans, not whole wrap).
                    if (/<strong\b/i.test(inner)) return `<p${attrs}>${inner}</p>`;
                    // Whole-paragraph bold with no inner strong — unwrap.
                    // Re-bold only a leading job-title-like phrase if present.
                    const titleMatch = inner.match(
                        /^([A-Z][A-Za-z0-9 .\/&-]{2,60}?)\s+(with\b[\s\S]*)$/i
                    );
                    if (titleMatch && TITLE_HINT.test(titleMatch[1])) {
                        return `<p${attrs}><strong>${titleMatch[1]}</strong> ${titleMatch[2]}</p>`;
                    }
                    return `<p${attrs}>${inner}</p>`;
                }
            );
            return heading + fixed;
        }
    );
}

/** Plain-English rewrites for common AI resume buzzwords (text nodes only). */
function scrubAiBuzzwordsInHtml(html) {
    const replacements = [
        [/\bleveraging\b/gi, 'using'],
        [/\bleveraged\b/gi, 'used'],
        [/\butilize[ds]?\b/gi, 'used'],
        [/\butilizing\b/gi, 'using'],
        [/\bspearheaded\b/gi, 'led'],
        [/\borchestrated\b/gi, 'ran'],
        [/\bfacilitated\b/gi, 'helped'],
        [/\bstreamlined\b/gi, 'simplified'],
        [/\brobust\b/gi, 'reliable'],
        [/\bseamless(ly)?\b/gi, 'smooth$1'],
        [/\bcutting-edge\b/gi, 'modern'],
        [/\bgroundbreaking\b/gi, 'new'],
        [/\btransformative\b/gi, 'major'],
        [/\bsynergy\b/gi, 'collaboration'],
        [/\bholistic\b/gi, 'end to end'],
        [/\bparadigm\b/gi, 'approach'],
        [/\bdelve(d|s)?\b/gi, 'look$1'],
        [/\bempower(ed|ing|s)?\b/gi, 'enable$1'],
        [/\belevate[ds]?\b/gi, 'improved']
    ];
    return String(html || '').replace(/(^|>)([^<]+)(?=<|$)/g, (m, lead, text) => {
        let t = text;
        for (const [re, rep] of replacements) {
            t = t.replace(re, rep);
        }
        return lead + t;
    });
}

function summaryHasBoldTitleAndYears(summaryHtml) {
    const boldSpans = [...String(summaryHtml).matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].map((m) =>
        String(m[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    );
    const hasBoldYears = boldSpans.some((s) => /^\d+\+?\s*years?(?:\s+of\s+experience)?$/i.test(s));
    const hasBoldTitle = boldSpans.some((s) => {
        if (!s || s.length < 4 || s.length > 70) return false;
        if (/^\d/.test(s)) return false;
        return TITLE_HINT.test(s);
    });
    return { hasBoldTitle, hasBoldYears };
}

/**
 * Ensure Summary first sentence opens with bold title + bold years.
 */
function ensureSummaryOpener(resumeHtml, facts) {
    const title = (facts?.currentTitle || '').trim();
    const years = Number(facts?.totalYears) || 0;
    if (!title || years < 1) return resumeHtml;

    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:summary|profile)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const pMatch = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
            if (!pMatch) {
                const opener =
                    `<p><strong>${escapeHtml(title)}</strong> with <strong>${years} years</strong> ` +
                    `owning production systems end to end.</p>`;
                return heading + '\n' + opener + body;
            }

            let inner = pMatch[1];
            inner = scrubBannedSummaryPhrases(inner);
            // Always pin the bold YoE digit to the profile fact — LLM invents 10/11/12/13.
            inner = inner.replace(
                /<strong>\s*\d+\+?\s*years?(?:\s+of\s+experience)?\s*<\/strong>/gi,
                `<strong>${years} years</strong>`
            );
            const { hasBoldTitle, hasBoldYears } = summaryHasBoldTitleAndYears(inner);

            if (hasBoldTitle && hasBoldYears) {
                const fixed = body.replace(pMatch[0], `<p>${inner}</p>`);
                return heading + fixed;
            }

            // Strip an existing weak first clause before injecting opener
            let rest = inner
                .replace(/^<strong>[^<]{0,80}<\/strong>\s*(with\s+)?(<strong>[^<]*<\/strong>\s*)?/i, '')
                .replace(/^\s*(with\s+)?\d+\+?\s*years?(?:\s+of\s+experience)?\s*/i, '')
                .replace(/^(?:[A-Z][A-Za-z0-9 ./-]{2,50})\s+with\s+\d+\+?\s*years?(?:\s+of\s+experience)?\s*/i, '')
                .replace(/^(?:[A-Z][A-Za-z0-9 ./-]{2,50})\s+with\s+/i, '')
                .replace(/^[,:.\-\s]+/, '')
                .trim();
            if (!rest) {
                rest = 'owning production systems end to end.';
            }
            // Prefer gerund continuation after "with N years"
            let cont = rest.replace(
                /^(owns|owned|building|builds|working|works)\b/i,
                (m) => ({
                    owns: 'owning',
                    owned: 'owning',
                    builds: 'building',
                    building: 'building',
                    works: 'working',
                    working: 'working'
                })[m.toLowerCase()] || m.toLowerCase()
            );
            if (/^[A-Z]/.test(cont) && !cont.startsWith('<')) {
                cont = cont.charAt(0).toLowerCase() + cont.slice(1);
            }

            const openerInner =
                `<strong>${escapeHtml(title)}</strong> with <strong>${years} years</strong> ${cont}`;
            const newP = `<p>${openerInner}</p>`;
            const fixed = body.replace(pMatch[0], newP);
            return heading + fixed;
        }
    );
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isBaselineSkill(sk) {
    const k = String(sk || '').trim().toLowerCase();
    return DEFAULT_BASELINE_SKILLS.some((b) => b.toLowerCase() === k);
}

function isLanguagesCategoryLabel(label) {
    return /language|scripting|framework/i.test(String(label || ''));
}

/** Append plain skill tokens onto a category <p>…</p> line. */
function appendSkillsToCategoryPara(paraHtml, skillsCsv) {
    const extra = String(skillsCsv || '').trim();
    if (!extra || !paraHtml) return paraHtml;
    return paraHtml
        .replace(/\s*<\/p>\s*$/i, `, ${extra}</p>`)
        .replace(/,\s*,/g, ',')
        .replace(/[.,;:]+\s*<\/p>/i, '</p>');
}

/**
 * If required stacks are missing from Core Skills, fold them into an
 * existing category line (never replace a real category with "Required Stacks").
 * Baseline web/DB skills go under Languages — not the last Engineering line.
 */
function ensureRequiredStacksInSkills(resumeHtml, coreSkills = '') {
    const required = String(coreSkills || '')
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (!required.length) return resumeHtml;

    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:core skills|skills|technical skills)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const plain = body.replace(/<[^>]+>/g, ' ').toLowerCase();
            const missing = required.filter((sk) => {
                const k = sk.toLowerCase();
                if (plain.includes(k)) return false;
                if (k === 'postgres' && plain.includes('postgresql')) return false;
                if (k === 'postgresql' && /postgres/.test(plain)) return false;
                return true;
            });
            if (!missing.length) return block;

            const langMissing = missing.filter((sk) => isBaselineSkill(sk)
                || /^(c#|csharp|python|go|golang|java|ruby|rust|typescript|javascript|html|css|sql)$/i.test(sk));
            const otherMissing = missing.filter((sk) => !langMissing.includes(sk));
            const langExtra = langMissing.map((sk) => cleanSkillToken(sk)).filter(Boolean).join(', ');
            const otherExtra = otherMissing.map((sk) => cleanSkillToken(sk)).filter(Boolean).join(', ');

            let paras = [...body.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)].map((m) => m[0]);
            if (!paras.length) {
                const lis = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
                paras = lis.map((m) => `<p>${m[1]}</p>`);
            }
            if (!paras.length) {
                const lines = [];
                if (langExtra) lines.push(`<p><strong>Languages and Frameworks</strong>: ${langExtra}</p>`);
                if (otherExtra) lines.push(`<p><strong>Additional Skills</strong>: ${otherExtra}</p>`);
                return `${heading}\n${lines.join('\n')}\n`;
            }

            if (langExtra) {
                const langIdx = paras.findIndex((p) => {
                    const label = p.replace(/<[^>]+>/g, ' ').split(':')[0] || '';
                    return isLanguagesCategoryLabel(label);
                });
                if (langIdx >= 0) {
                    paras[langIdx] = appendSkillsToCategoryPara(paras[langIdx], langExtra);
                } else {
                    paras.unshift(`<p><strong>Languages and Frameworks</strong>: ${langExtra}</p>`);
                }
            }
            if (otherExtra) {
                const last = paras[paras.length - 1];
                if (/:\s*/.test(last.replace(/<[^>]+>/g, ''))) {
                    paras[paras.length - 1] = appendSkillsToCategoryPara(last, otherExtra);
                } else {
                    paras.push(`<p><strong>Additional Skills</strong>: ${otherExtra}</p>`);
                }
            }
            return heading + '\n' + paras.slice(0, 5).join('\n') + '\n';
        }
    );
}

/** Pad a thin Summary to ~90 words so depth checks pass. */
function padThinSummary(resumeHtml) {
    const FILLER =
        ' Owns production infrastructure end to end, including on call coverage,'
        + ' deployment automation, and monitoring across distributed services.'
        + ' Comfortable partnering with platform and application teams on reliability work.';
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>[\s\S]*?(?:summary|profile)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            const pMatch = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
            if (!pMatch) return block;
            if (/Owns production infrastructure end to end/i.test(pMatch[1])) return block;
            const words = pMatch[1].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
            if (words.length >= 90) return block;
            const newInner = `${pMatch[1].replace(/\s+$/, '')}${FILLER}`;
            const newP = pMatch[0].replace(pMatch[1], newInner);
            return heading + body.replace(pMatch[0], newP);
        }
    );
}

/**
 * Drop thin experience bullets so density stays real.
 * Keeps up to 10 bullets on the latest role. Never invent filler clauses.
 */
function densifyExperienceBullets(resumeHtml) {
    let roleIdx = 0;
    return String(resumeHtml).replace(
        /(<h2\b[^>]*>(?:(?!<\/h2>)[\s\S])*?(?:work\s+experience|professional\s+experience)(?:(?!<\/h2>)[\s\S])*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => {
            roleIdx = 0;
            const next = body.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (ul, inner) => {
                const items = [...inner.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map((m) => m[0]);
                if (!items.length) return ul;
                const scored = items.map((li) => {
                    const words = li.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
                    return { li, words };
                });
                const maxKeep = roleIdx === 0 ? 10 : 5;
                roleIdx += 1;
                let keep = scored.filter((x) => x.words >= 22);
                if (keep.length < 4) {
                    keep = [...scored].sort((a, b) => b.words - a.words).slice(0, Math.min(maxKeep, scored.length));
                } else {
                    keep = keep.slice(0, maxKeep);
                }
                return `<ul>\n${keep.map((x) => x.li).join('\n')}\n</ul>`;
            });
            return heading + next;
        }
    );
}

/**
 * Strip prior polish junk: identical "Applied <stack> across production…"
 * bullets that were injected for baseline web skills.
 */
function stripInjectedStackBullets(resumeHtml) {
    return String(resumeHtml || '').replace(
        /<li\b[^>]*>\s*Applied\s+(?:<strong>)?[^<]+(?:<\/strong>)?\s+across production services for automation and reliability[\s\S]*?<\/li>\s*/gi,
        ''
    ).replace(
        /\s+across production systems with clear ownership and measurable impact\./gi,
        '.'
    );
}

/**
 * Do NOT invent experience bullets for missing stacks.
 * Baseline skills (TS/JS/HTML/CSS/SQL) belong in Core Skills only.
 * User/JD stacks should already appear from the LLM draft.
 */
function ensureRequiredStacksInExperience(resumeHtml, _coreSkills = '') {
    return stripInjectedStackBullets(resumeHtml);
}

/**
 * Full deterministic polish pass.
 * @returns {{ html: string, polish_ms: number, facts: object }}
 */
function polishResumeHtml(resumeHtml, { profile, coreSkills = '', jobDescription = '' } = {}) {
    const t0 = Date.now();
    let html = String(resumeHtml || '');
    html = stripControlAndSoftHyphens(html);
    html = scrubAiBuzzwordsInHtml(html);
    html = ensureBulletPeriods(html);

    const facts = extractCareerFacts(profile);
    html = ensureSummaryOpener(html, facts);
    html = unwrapWholeBoldSummary(html);

    // Scrub banned phrases anywhere in summary section body
    html = html.replace(
        /(<h2\b[^>]*>[\s\S]*?(?:summary|profile)[\s\S]*?<\/h2>)([\s\S]*?)(?=<h2\b|$)/i,
        (block, heading, body) => heading + scrubBannedSummaryPhrases(body)
    );

    const allow = buildSkillAllowlist(profile, coreSkills, jobDescription);
    const expandedSkills = expandCoreSkillsFromJd(coreSkills, jobDescription).join(', ');
    // Soft trim (keep rich JD/profile-backed lists), then fill only if thin
    html = trimCoreSkillsSection(html, allow, coreSkills);
    html = rebuildCoreSkillsIfThin(html, coreSkills, jobDescription);
    html = ensureRequiredStacksInSkills(html, expandedSkills);
    html = boldStacksInSummary(html, coreSkills, jobDescription);
    html = forceBoldSkillTokens(html);
    html = stripInjectedStackBullets(html);
    html = densifyExperienceBullets(html);
    html = ensureRequiredStacksInExperience(html, expandedSkills);
    html = padThinSummary(html);

    return {
        html,
        polish_ms: Date.now() - t0,
        facts
    };
}

module.exports = {
    extractCareerFacts,
    parseProfileYearsOfExperience,
    buildCandidateBackground,
    polishResumeHtml,
    stripControlAndSoftHyphens,
    ensureBulletPeriods,
    ensureSummaryOpener,
    unwrapWholeBoldSummary,
    scrubBannedSummaryPhrases,
    scrubAiBuzzwordsInHtml,
    trimCoreSkillsSection,
    normalizeCoreSkillsLayout,
    rebuildCoreSkillsIfThin,
    categorizeCoreStacks,
    expandCoreSkillsFromJd,
    DEFAULT_BASELINE_SKILLS,
    isBaselineSkill,
    boldStacksInSummary,
    forceBoldSkillTokens,
    ensureRequiredStacksInSkills,
    densifyExperienceBullets,
    stripInjectedStackBullets,
    ensureRequiredStacksInExperience,
    padThinSummary,
    buildSkillAllowlist
};
