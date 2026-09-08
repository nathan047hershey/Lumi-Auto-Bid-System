// =============================================================================
// DOCX content extractor
// =============================================================================
// Given a DOCX resume template buffer, pull out the candidate data the
// template *contains* (as placeholder text, sample content, or as the only
// real values the admin typed in). The output drives two flows:
//
//   1. admin-side preview — surface what we detected so the admin can see
//      what the parser found before applying it.
//   2. apply-to-profile   — create or update a `candidate_profiles` row
//      from the extracted values via the apply endpoint.
//
// Strategy:
//   - use `mammoth` to convert DOCX → plain text (best fidelity for the
//     resume-shaped content we expect).
//   - run a battery of targeted regexes for contact info (email, phone,
//     URLs, location).
//   - segment the remaining text into sections by header keywords (Summary,
//     Skills, Experience, Education) and parse each section into structured
//     rows (job entries / degree entries).
//   - never throw on weird input — return partial data and a `notes` array
//     describing what was and wasn't detected.
//
// Output shape:
//   {
//     name: { first, last, middle },
//     contact: { email, phone, linkedin_url, github_url },
//     location: { city, state, country },
//     summary: string,
//     skills: [string],
//     work_experience: [
//       { title, company, location, start, end, current, bullets: [string] }
//     ],
//     education: [
//       { degree, school, start, end, current, gpa }
//     ],
//     raw_text: string,     // full extracted text — useful for debugging
//     notes: [string]       // human-readable observations
//   }
// =============================================================================

const mammoth = require('mammoth');
const axios = require('axios');
const { getProviderConfig } = require('./settingsService');

// --- helpers ---------------------------------------------------------------

function tryRegex(text, re) {
    const m = text.match(re);
    return m ? (m[1] || m[0]).trim() : null;
}

// Split a contact line ("City, ST | email | phone | linkedin") into pieces
// separated by |, •, ·, or commas at the top level. Returns non-empty
// trimmed tokens.
function splitContactParts(line) {
    if (!line) return [];
    return line
        .split(/\s*(?:\||\u2022|\u00b7|\u00a0)\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
}

// --- extraction primitives -------------------------------------------------

function extractEmail(text) {
    return tryRegex(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
}

function extractPhone(text) {
    // Loose match: international + nanp-style, optional separators, 7-15 digits.
    // Prefers the first match in the document; later lines (with years like
    // "2018 - 2020") won't trip it.
    const candidates = [
        // +CC (NNN) NNN-NNNN / +CC NNN NNN NNNN
        /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/,
        // (NNN) NNN-NNNN
        /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/,
        // NNN-NNN-NNNN
        /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
        // NNNNNNNNNN (10-digit bare)
        /\b\d{10}\b/,
        // 11+ digit bare (international without +)
        /\b\d{11,15}\b/
    ];
    for (const re of candidates) {
        const m = text.match(re);
        if (m) return m[0].trim();
    }
    return null;
}

function extractLinkedin(text) {
    return tryRegex(text, /https?:\/\/(?:www\.)?linkedin\.com\/[^\s)"]+/i)
        || tryRegex(text, /linkedin\.com\/[^\s)"]+/i);
}

function extractGithub(text) {
    return tryRegex(text, /https?:\/\/(?:www\.)?github\.com\/[^\s)"]+/i)
        || tryRegex(text, /github\.com\/[^\s)"]+/i);
}

// Extract a "City, ST" or "City, Country" location. Two-letter codes that
// aren't US state codes are treated as the country code (e.g. "ZM" for
// Zambia, "CA" for Canada, "GB" for the UK).
function extractLocation(text, notes) {
    const US_STATES = new Set([
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
        'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
        'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
        'VA','WA','WV','WI','WY','DC'
    ]);

    // Identify the candidate's name line so we can exclude it from the
    // location scan — mammoth sometimes joins the name + contact line
    // when a page header / no-break-space is involved.
    const nameInfo = extractName(text, []);

    // Scan the first 12 lines individually, skipping the name line.
    const earlyLines = text.split('\n').slice(0, 12);
    for (const line of earlyLines) {
        const t = line.trim();
        if (!t) continue;
        // Skip the name line(s) outright.
        if (t === nameInfo.first
            || t === [nameInfo.first, nameInfo.last].filter(Boolean).join(' ')
            || t === [nameInfo.first, nameInfo.middle, nameInfo.last].filter(Boolean).join(' ')) continue;

        // "City, ST" — 2-letter code right after a comma.
        const re = /([A-Z][A-Za-z\.'-]+(?:\s[A-Z][A-Za-z\.'-]+)*)\s*,\s*([A-Z]{2})\b/;
        const m = t.match(re);
        if (m) {
            const code = m[2].toUpperCase();
            if (US_STATES.has(code)) {
                return { city: m[1].trim(), state: code, country: 'US' };
            }
            return { city: m[1].trim(), state: null, country: code };
        }
        // "City, State, Country" — full spelled-out form.
        const re2 = /([A-Z][A-Za-z\.'-]+(?:\s[A-Z][A-Za-z\.'-]+)*)\s*,\s*([A-Z][A-Za-z]+)\s*,\s*([A-Z][A-Za-z]+)/;
        const m2 = t.match(re2);
        if (m2) {
            return { city: m2[1].trim(), state: m2[2].trim(), country: m2[3].trim() };
        }
    }
    notes.push('No city/state detected — only job locations were found.');
    return { city: null, state: null, country: null };
}

// Identify the candidate's name from the very top of the document. The first
// line that looks like a name (1-4 capitalised words, no digits, not an
// obvious section header) is almost always the candidate's full name.
const NAME_LINE_RE = /^([A-Z][a-zA-Z'\-]+)(?:\s+([A-Z][a-zA-Z'\-]+))(?:\s+([A-Z][a-zA-Z'\-]+))?(?:\s+([A-Z][a-zA-Z'\-]+))?\s*$/;

function extractName(text, notes) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 6)) {
        // Skip lines that contain an @, a digit, or look like a heading.
        if (/[@\d]/.test(line)) continue;
        if (/^(summary|profile|about|skills?|experience|education|contact)$/i.test(line)) continue;
        // Skip lines that contain a "|" — those are contact lines.
        if (line.includes('|')) continue;
        const m = line.match(NAME_LINE_RE);
        if (m) {
            const parts = [m[1], m[2], m[3], m[4]].filter(Boolean);
            if (parts.length >= 2 && parts.length <= 4) {
                return splitName(parts);
            }
        }
    }
    notes.push('No candidate name detected at the top of the document.');
    return { first: null, middle: null, last: null };
}

function splitName(parts) {
    if (parts.length === 2) return { first: parts[0], middle: null, last: parts[1] };
    if (parts.length === 3) return { first: parts[0], middle: parts[1], last: parts[2] };
    // 4 tokens: First Middle1 Middle2 Last
    return {
        first: parts[0],
        middle: parts.slice(1, -1).join(' '),
        last: parts[parts.length - 1]
    };
}

// --- section segmentation --------------------------------------------------

// Detect section boundaries from header lines. Returns { summary, skills,
// experience, education } as raw text slices (paragraphs preserved as
// newlines).
function splitSections(text) {
    // Each entry: { key, aliases[] }. Aliases are matched against the
    // trimmed header line, case-insensitive, with optional trailing colon
    // and surrounding whitespace. Aliases must cover the way humans
    // actually label these sections — there are a lot of variants.
    const SECTION_PATTERNS = [
        {
            key: 'summary',
            aliases: [
                'summary', 'professional summary', 'profile', 'about',
                'about me', 'objective', 'career objective', 'personal statement',
                'overview', 'introduction'
            ]
        },
        {
            key: 'skills',
            aliases: [
                'skills', 'core skills', 'technical skills', 'key skills',
                'technologies', 'tech stack', 'skill set', 'areas of expertise',
                'core competencies', 'competencies', 'expertise',
                'tools', 'tools & technologies', 'languages', 'programming languages'
            ]
        },
        {
            key: 'experience',
            aliases: [
                'experience', 'work experience', 'professional experience',
                'employment', 'employment history', 'career history',
                'work history', 'professional history', 'career',
                'positions', 'roles'
            ]
        },
        {
            key: 'education',
            aliases: [
                'education', 'academic background', 'qualifications',
                'academic history', 'educational background', 'training',
                'academics'
            ]
        },
        {
            key: 'projects',
            aliases: [
                'projects', 'personal projects', 'side projects', 'selected projects',
                'notable projects', 'key projects', 'open source'
            ]
        },
        {
            key: 'certifications',
            aliases: [
                'certifications', 'certificates', 'licenses', 'awards',
                'honors', 'honors & awards', 'achievements', 'accreditations'
            ]
        },
        {
            key: 'publications',
            aliases: [
                'publications', 'papers', 'research', 'talks', 'speaking'
            ]
        },
        {
            key: 'volunteer',
            aliases: [
                'volunteer', 'volunteer experience', 'community',
                'community involvement'
            ]
        },
        {
            key: 'interests',
            aliases: [
                'interests', 'hobbies', 'activities'
            ]
        }
    ];

    // Pre-compile one regex per alias so the loop stays tight even when
    // the section list grows. Each alias gets anchored to start/end so a
    // line like "Summary of qualifications" doesn't accidentally match.
    const compiled = SECTION_PATTERNS.map((p) => ({
        key: p.key,
        regexes: p.aliases.map((a) => new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*$`, 'i'))
    }));

    const lines = text.split('\n');
    const sections = {};
    let currentKey = null;
    let currentBuf = [];

    const flush = () => {
        if (currentKey) sections[currentKey] = currentBuf.join('\n').trim();
    };

    for (const line of lines) {
        const t = line.trim();
        let matched = false;
        for (const { key, regexes } of compiled) {
            if (regexes.some((re) => re.test(t))) {
                flush();
                currentKey = key;
                currentBuf = [];
                matched = true;
                break;
            }
        }
        if (!matched && currentKey) currentBuf.push(line);
    }
    flush();

    return sections;
}

// --- experience parsing ----------------------------------------------------

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)';

function extractDateRange(text) {
    // Match patterns like:
    //   2020 - 2024            (plain year ranges)
    //   2020-2024              (no spaces)
    //   Jan 2020 - Mar 2024    (month + year ranges)
    //   January 2020 - Present
    //   01/2020 - 03/2024      (numeric month/year)
    //
    // Group layout:
    //   1 = leading start month (e.g. "Jan")
    //   2 = start year / numeric
    //   3 = trailing end month  (e.g. "Mar")
    //   4 = end year / numeric
    //   5 = end sentinel ("Present"/"Current") when no end year given
    //
    // We use a lookbehind for the boundary so the prefix char isn't
    // consumed — otherwise the optional month group gets skipped when
    // the leading alternative `^` fails (which it always does mid-string).
    // A 4-digit number can ONLY be a date if it's preceded by start-of-
    // string, whitespace, comma, open paren, or a literal `-` (the last
    // covers bullet-style "• 2020 - 2024"). We deliberately do NOT allow
    // digits, so a phone number "415-555-1234" with another 4-digit
    // cluster nearby won't trip the matcher.
    const re = new RegExp(
        `(?:(?<=^|[\\s,(])(${MONTHS})\\s+)?(?<=^|[\\s,(])(\\d{4}|\\d{1,2}\\/\\d{4})\\s*[-–to]+\\s*(?:(${MONTHS})\\s+)?(?:(\\d{4}|\\d{1,2}\\/\\d{4})|(Present|present|current|Current))`,
        'i'
    );
    const m = text.match(re);
    if (!m) return { start: null, end: null, current: false };
    const startMonth = m[1] || '';
    const startYear = m[2];
    const endMonth = m[3] || '';
    const endYear = m[4];
    const endSentinel = m[5];
    const current = !!endSentinel;
    return {
        start: `${startMonth} ${startYear}`.trim(),
        end: current ? null : `${endMonth} ${endYear || ''}`.trim() || null,
        current
    };
}

// Split an Experience section into per-job entries. Heuristics:
//   - blank line = potential new entry
//   - if a line contains a date range (e.g. "Jan 2020 - Present"), it's the
//     header line for a NEW job entry
//   - bullet lines (those starting with • / - / * or plain-text bullets)
//     without a date range are merged into the PREVIOUS job entry as bullets
function parseExperience(rawText) {
    if (!rawText) return [];

    // Strip residual HTML bold tags. Each line is then a candidate for
    // either a job-header row or a bullet.
    const lines = rawText
        .replace(/<\/?strong>/g, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const BULLET_PREFIX_RE = /^[•●▪◦·\*\-]\s+/;
    const NUMBERED_PREFIX_RE = /^\d+[\.\)]\s+/;

    // A "header window" is the run of consecutive non-bullet lines that
    // ends as soon as we hit either a date-range line or a bullet. We use
    // a 4-line look-ahead to decide whether a non-bullet line is the
    // start of a job header: if a date-range line appears within the
    // next 3 lines, treat the whole span as the header. If a date
    // appears further out, or there's no date within the window, we
    // drop the line as stray prose.
    //
    // The strategy is:
    //   1. Walk lines, accumulating a "pendingHeader" list as long as
    //      lines look like header rows.
    //   2. When a line IS a date-range line and pendingHeader is
    //      non-empty, attach it as the final header line.
    //   3. When we hit a bullet, switch to bullet-collection mode until
    //      a new header begins (date or pipe).
    //   4. Flush when a new header boundary begins or at end of input.
    const blocks = [];
    let pendingHeaderLines = [];
    let pendingBullets = [];

    // Find the index of the next line that contains a date range within
    // a forward window of `window` lines from position `from`. Returns
    // the absolute index, or -1 if none.
    function nextDateIndex(from, window = 4) {
        for (let j = from + 1; j < Math.min(lines.length, from + window + 1); j++) {
            if (!BULLET_PREFIX_RE.test(lines[j]) && !NUMBERED_PREFIX_RE.test(lines[j])) {
                if (extractDateRange(lines[j]).start) return j;
            }
        }
        return -1;
    }

    const flush = () => {
        if (!pendingHeaderLines.length && !pendingBullets.length) return;
        const headerText = pendingHeaderLines.join(' | ');
        const entry = parseJobHeader(headerText);
        entry.bullets = pendingBullets;
        // Drop completely-empty synthetic entries (e.g. stray prose
        // before any real header).
        if (entry.title || entry.company || entry.start || entry.bullets.length) {
            blocks.push(entry);
        }
        pendingHeaderLines = [];
        pendingBullets = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isBullet = BULLET_PREFIX_RE.test(line) || NUMBERED_PREFIX_RE.test(line);

        if (isBullet) {
            // Switch to bullet mode. If we're mid-header, end the header
            // here (it must have ended on a previous date-line if it has
            // any date information).
            pendingBullets.push(line.replace(BULLET_PREFIX_RE, '').replace(NUMBERED_PREFIX_RE, '').trim());
            continue;
        }

        const hasDate = !!extractDateRange(line).start;
        const hasPipe = line.includes('|');
        const isShort = line.length <= 80 && !/[.;]\s/.test(line);  // heuristic: a header row rarely has a sentence

        // A line that already carries a date range or pipe is a clear
        // header row.
        if (hasDate || hasPipe) {
            if (pendingHeaderLines.length || pendingBullets.length) flush();
            pendingHeaderLines.push(line);
            continue;
        }

        // Plain short line: this could be the start of a new header
        // window, or a continuation of the current one. If we have any
        // accumulated state (header lines or bullets), the previous job
        // is over — flush it now and start a fresh header.
        if (pendingHeaderLines.length || pendingBullets.length) {
            flush();
        }

        if (isShort) {
            const nextDateAt = nextDateIndex(i, 4);
            if (nextDateAt > 0) {
                // Greedily collect up to the date line as header lines.
                pendingHeaderLines.push(line);
                for (let j = i + 1; j <= nextDateAt; j++) {
                    pendingHeaderLines.push(lines[j]);
                }
                i = nextDateAt;   // jump past the date line (next iter continues from i+1)
                continue;
            }
            // No date nearby — stray prose. Drop it.
            continue;
        }

        // Long line that isn't a bullet, isn't a header — drop.
    }
    flush();
    return blocks;
}

// Decide whether a single line looks like part of a job-header row.
// Used both for "is this a fresh header" detection and for the line-by-line
// collection mode.
function isJobHeaderLine(line) {
    if (!line) return false;
    // Lines with a date range are always header rows.
    if (extractDateRange(line).start) return true;
    // Lines with a clear separator and ≥2 segments are header rows.
    const pipeCount = (line.match(/\|/g) || []).length;
    if (pipeCount >= 1) return true;
    // Lines that look like a single short capitalised noun phrase with
    // no period at the end (e.g. "Acme Corp" or "San Francisco, CA") are
    // likely Company / Location rows — but ONLY if we're already in
    // header-collection mode. The caller passes `inHeader` for this.
    // Here, when called standalone, we return false to stay conservative.
    return false;
}

// Convert a header string (one or more lines joined by " | ") into a
// structured job entry. Tolerates the AI's "Title | Company | Location |
// Dates" layout, the common "Title\nCompany\nLocation\nDates" layout
// (which is joined with " | " upstream), and a few variants.
function parseJobHeader(headerText) {
    const segments = headerText
        .split(/\s*\|\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

    // Try to pull a date range from anywhere in the header — it may
    // appear in the last segment (the common case) or anywhere else.
    const dates = extractDateRange(headerText);

    // Map each non-date segment to its most likely role. We use a few
    // heuristics to assign Title / Company / Location:
    //   - "Location" segments tend to contain a comma or state code and
    //     rarely end with a date.
    //   - "Company" segments tend to be 1-4 capitalised words.
    //   - The first segment is almost always the Title.
    const cleanedSegments = segments.map((s) => stripDateSegment(s));
    const nonDateSegments = cleanedSegments.filter(Boolean);

    let title = null, company = null, location = null;
    if (nonDateSegments.length === 1) {
        title = nonDateSegments[0];
    } else if (nonDateSegments.length >= 2) {
        title = nonDateSegments[0];
        // Decide between company and location for the remaining segments.
        // Heuristic: a segment with a comma or a 2-letter state code is a
        // location; otherwise it's a company.
        const rest = nonDateSegments.slice(1);
        const locIdx = rest.findIndex(isLocationLike);
        if (locIdx >= 0) {
            location = rest[locIdx];
            // Whatever's left after removing the location goes to company
            // (concatenate with " — " if there are multiple non-location
            // segments, since some resumes use a parent/subsidiary split).
            const companyParts = rest.filter((_, i) => i !== locIdx);
            company = companyParts.length ? companyParts.join(' — ') : null;
        } else {
            company = rest.join(' — ');
        }
    }

    return {
        title: cleanField(title),
        company: cleanField(company),
        location: cleanField(location),
        start: dates.start || null,
        end: dates.end || null,
        current: !!dates.current,
        bullets: []
    };
}

function stripDateSegment(s) {
    // Strip ANY date-range suffix from a segment, including an optional
    // leading separator + start month. Anchored to end-of-string so the
    // job-title / company name at the start of the segment is preserved.
    //   "Acme Corp — Jan 2020 - Present" → "Acme Corp —"
    //   "Senior Engineer | 2022 - 2024"   → "Senior Engineer"
    //   "Onsite | Jan 2022"               → "Onsite"
    //   "Jan 2022"                        → "" (whole thing is a date)
    //
    // The trailing half of the regex matches: optional start month +
    // year + optional "- end month + year-or-sentinel". The leading
    // separator group accepts " | " / " — " / " - " / " / " / " " before
    // the date. When the date is the entire segment, the leading
    // separator is missing and the regex still matches the date itself.
    const re = new RegExp(
        `(?:\\s*[\\-–—|,/]\\s*|^)` +
        `(?:(${MONTHS})\\s+)?(\\d{4}|\\d{1,2}\\/\\d{4})` +
        `(?:\\s*[-–to]+\\s*(?:(${MONTHS})\\s+)?(?:\\d{4}|\\d{1,2}\\/\\d{4}|Present|present|current|Current))?` +
        `\\s*$`,
        'i'
    );
    return s.replace(re, '').trim() || null;
}

function isLocationLike(s) {
    if (!s) return false;
    return (
        /,\s*[A-Z]{2}\b/.test(s) ||                    // "City, ST"
        /,\s*[A-Z][a-z]+/.test(s) ||                   // "City, Country"
        /^(Remote|On-site|Onsite|Hybrid|WFH)$/i.test(s) ||
        /\b(Remote|On-site|Onsite|Hybrid)\b/i.test(s)
    );
}

function cleanField(s) {
    if (!s) return null;
    const out = s.replace(/<\/?[^>]+>/g, '').replace(/[`*_~]/g, '').trim();
    return out || null;
}

function parseEducation(rawText) {
    if (!rawText) return [];

    // Strip the section header if present (mammoth sometimes includes it).
    const cleaned = rawText
        .replace(/<\/?strong>/g, '')
        .replace(/^[\s\S]*?(?:education|academic background|qualifications)\s*:?\s*\n?/i, '')
        .trim();

    // Split into blocks — each block is a single degree. The boundary
    // heuristic is:
    //   - blank line = new block
    //   - a line that contains a date range AND is preceded by a school
    //     name on the previous line also counts as a block boundary
    //     (this catches "School\nDegree | Dates" layouts).
    const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

    const blocks = [];
    let buf = [];
    const flush = () => {
        if (buf.length) {
            blocks.push(buf);
            buf = [];
        }
    };

    for (const line of lines) {
        // A date range starts a new block (degrees almost always have a
        // year range on the same line as the school or the degree).
        if (buf.length && /(\b(19|20)\d{2}\b|Present|Current)/i.test(line)) {
            flush();
        }
        buf.push(line);
    }
    flush();

    const entries = [];
    for (const blockLines of blocks) {
        const headerText = blockLines.join(' | ');
        const dates = extractDateRange(headerText);
        const segments = headerText
            .split(/\s*\|\s*/)
            .map((s) => s.trim())
            .filter(Boolean);
        // Strip trailing dates from any segment.
        const cleanSegments = segments
            .map((s) => stripDateSegment(s))
            .filter(Boolean);

        let degree = null, school = null, gpa = null;
        if (cleanSegments.length === 1) {
            degree = cleanSegments[0];
        } else if (cleanSegments.length >= 2) {
            // First segment is almost always the degree; second is the
            // school. Remaining segments (e.g. "GPA: 3.8/4.0", honors)
            // are dropped into the `gpa` / extras slot.
            degree = cleanSegments[0];
            school = cleanSegments[1];
            const extras = cleanSegments.slice(2);
            const gpaMatch = extras.join(' | ').match(/\bGPA\s*[:\-]?\s*([0-9.]+\s*\/\s*[0-9.]+)/i);
            if (gpaMatch) gpa = gpaMatch[1].replace(/\s+/g, '');
        }
        entries.push({
            degree: cleanField(degree),
            school: cleanField(school),
            start: dates.start || null,
            end: dates.end || null,
            current: !!dates.current,
            gpa: gpa || null
        });
    }
    return entries;
}

function parseSkills(rawText) {
    if (!rawText) return [];

    // Strip the section header if it slipped into the body. Mammoth export
    // sometimes leaves the "Skills" line in the section's text content.
    const cleaned = rawText
        .replace(/^[\s\S]*?(?:core\s+skills|technical\s+skills|key\s+skills|skills|technologies)\s*:?\s*\n?/i, '');

    // Split into raw lines. We support several common shapes:
    //   - "JavaScript, React, Node.js"
    //   - "JavaScript\nReact\nNode.js"
    //   - "• JavaScript\n• React\n• Node.js"
    //   - "1. JavaScript\n2. React\n3. Node.js"
    //   - "Languages: JavaScript, TypeScript\nFrameworks: React, Vue"
    const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

    const skills = [];
    const seen = new Set();
    const BULLET_PREFIX_RE = /^[•●▪◦·\*\-]\s+/;
    const NUMBERED_PREFIX_RE = /^\d+[\.\)]\s+/;

    for (const line of lines) {
        // Drop common "group header" suffixes — "Languages: JS, TS" should
        // emit ["JavaScript", "TypeScript"], not ["Languages", "JavaScript",
        // "TypeScript"].
        const colonParts = line.split(':');
        if (colonParts.length === 2) {
            const groupLabel = colonParts[0].trim();
            const items = colonParts[1].split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
            // Only treat the leading chunk as a group label if it's short
            // and looks like a noun phrase (e.g. "Languages", "Frameworks").
            if (groupLabel.length <= 30 && /^[A-Z][A-Za-z &/]+$/.test(groupLabel)) {
                for (const it of items) pushSkill(skills, seen, it);
                continue;
            }
        }
        // Otherwise treat the whole line as one-or-more comma-separated items.
        const stripped = line.replace(BULLET_PREFIX_RE, '').replace(NUMBERED_PREFIX_RE, '');
        for (const item of stripped.split(/[,;|]/)) {
            pushSkill(skills, seen, item);
        }
    }
    return skills;
}

function pushSkill(skills, seen, raw) {
    if (!raw) return;
    let s = String(raw).trim();
    // Strip residual HTML / markdown noise
    s = s.replace(/<\/?[^>]+>/g, '').replace(/[`*_~]/g, '').trim();
    if (!s) return;
    // Reject obvious non-skill content: too long, ends with a sentence
    // period (likely a stray sentence that leaked in), contains digits in
    // a year-like pattern (e.g. "2018-2020"), or is a section header.
    if (s.length > 80) return;
    if (/^(skills|core skills|technical skills|technologies|key skills|languages)$/i.test(s)) return;
    if (/\b(19|20)\d{2}\b/.test(s)) return;
    // Dedup case-insensitively while preserving first-seen casing.
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    skills.push(s);
}

// --- public entry point ----------------------------------------------------

async function extractCandidateFromDocx(buffer) {
    const notes = [];
    let rawText = '';
    try {
        const result = await mammoth.extractRawText({ buffer });
        rawText = (result?.value || '').replace(/\r\n/g, '\n');
        if (result?.messages?.length) {
            for (const m of result.messages.slice(0, 5)) {
                if (m.type === 'warning') notes.push(`Mammoth warning: ${m.message}`);
            }
        }
    } catch (err) {
        notes.push(`Failed to read DOCX as text: ${err.message}`);
        return { raw_text: '', notes, error: err.message };
    }

    if (!rawText.trim()) {
        notes.push('Document contained no extractable text.');
        return {
            name: { first: null, middle: null, last: null },
            contact: { email: null, phone: null, linkedin_url: null, github_url: null },
            location: { city: null, state: null, country: null },
            summary: null,
            skills: [],
            work_experience: [],
            education: [],
            raw_text: '',
            notes
        };
    }

    // First few lines of the document — almost always contain name + contact.
    const head = rawText.split('\n').slice(0, 12).join('\n');
    const name = extractName(rawText, notes);
    const email = extractEmail(rawText);
    const phone = extractPhone(rawText);
    const linkedin_url = extractLinkedin(rawText);
    const github_url = extractGithub(rawText);
    const location = extractLocation(rawText, notes);

    // If we found name + (email or phone) on the same first 6 lines but
    // missed the contact split, surface a note. Most templates do show
    // contact right under the name.
    if (!email && !phone && !linkedin_url) {
        notes.push('No email, phone, or LinkedIn detected in the document head.');
    }

    const sections = splitSections(rawText);
    // Strip the section header line if mammoth included it in the body
    // (e.g. "Summary\n\nThree paragraphs…" — we want only the paragraphs).
    function stripHeader(text, aliases) {
        if (!text) return text;
        const escaped = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        return text.replace(new RegExp(`^\\s*(?:${escaped})\\s*:?\\s*\\n`, 'i'), '').trim();
    }
    const summaryRaw = stripHeader(sections.summary, [
        'professional summary', 'summary', 'profile', 'about', 'about me', 'objective', 'career objective', 'personal statement', 'overview', 'introduction'
    ]);
    let summary = summaryRaw || null;
    let skills = parseSkills(sections.skills);
    let work_experience = parseExperience(sections.experience);
    let education = parseEducation(sections.education);
    // Tracks how the structured fields were produced so the admin UI can
    // label extraction as "regex-only" vs "AI-assisted".
    let extraction_source = 'regex';

    if (!sections.summary)    notes.push('No "Summary" / "Profile" section detected.');
    if (!sections.skills)     notes.push('No "Skills" section detected.');
    if (!sections.experience) notes.push('No "Experience" section detected.');
    if (!sections.education)  notes.push('No "Education" section detected.');

    // ----- AI-assisted refinement -----
    // The regex pass above is fast and dependency-free but breaks on
    // unconventional layouts. When the active AI provider is configured
    // (admin can toggle MiniMax / DeepSeek in Settings) we make a second
    // pass that asks the model to detect sections, then merge its output
    // on top of the regex results: keep fields the regex already filled,
    // fill in any field the AI saw that we missed.
    //
    // Failures here are non-fatal — we always return the regex output.
    if (shouldUseAi()) {
        try {
            const ai = await detectSectionsWithAi(rawText);
            if (ai && !ai.error) {
                const before = {
                    summary: !!summary,
                    skills: skills.length,
                    work: work_experience.length,
                    education: education.length
                };
                summary = summary || ai.summary || null;
                if ((!skills || skills.length === 0) && Array.isArray(ai.skills) && ai.skills.length) {
                    skills = ai.skills;
                }
                if ((!work_experience || work_experience.length === 0) && Array.isArray(ai.work_experience) && ai.work_experience.length) {
                    work_experience = ai.work_experience;
                }
                if ((!education || education.length === 0) && Array.isArray(ai.education) && ai.education.length) {
                    education = ai.education;
                }
                extraction_source = ai.provider
                    ? `ai:${ai.provider}:${ai.model || ''}`
                    : 'ai';
                notes.push(`Section detection assisted by ${ai.provider || 'AI'} (${ai.model || 'default model'}).`);
                if (ai.section_order && Array.isArray(ai.section_order)) {
                    notes.push(`AI detected section order: ${ai.section_order.join(' → ')}`);
                }
                const after = {
                    summary: !!summary,
                    skills: skills.length,
                    work: work_experience.length,
                    education: education.length
                };
                const aiAdded = (after.summary && !before.summary)
                    || (after.skills > before.skills)
                    || (after.work > before.work)
                    || (after.education > before.education);
                if (aiAdded) notes.push('AI filled gaps that the regex pass missed.');
            } else if (ai && ai.error) {
                notes.push(`AI section detection skipped: ${ai.error}`);
            }
        } catch (aiErr) {
            notes.push(`AI section detection failed (regex results kept): ${aiErr.message}`);
        }
    } else {
        notes.push('AI section detection skipped (no API key for the active provider).');
    }

    return {
        name,
        contact: { email, phone, linkedin_url, github_url },
        location,
        summary,
        skills,
        work_experience,
        education,
        raw_text: rawText,
        extraction_source,
        notes
    };
}

// =============================================================================
// AI-assisted section detection
// =============================================================================
// On top of the regex pass, ask the active AI provider (MiniMax by default
// or DeepSeek depending on app settings) to identify resume sections.
//
// We pass the raw text and ask for a strict JSON response with the same
// shape we use internally. The function is fully defensive: any failure
// (network, parse, model refusal) returns `{ error }` so the caller can
// keep the regex output and never break the upload.
// =============================================================================

// Global toggle. The default is "use AI when an API key exists for the
// active provider". Admins can force-disable with EXTRACTOR_USE_AI=0.
// A future Settings UI can flip this without redeploying.
function shouldUseAi() {
    if (process.env.EXTRACTOR_USE_AI === '0' || process.env.EXTRACTOR_USE_AI === 'false') {
        return false;
    }
    try {
        const cfg = getProviderConfig();
        return !!(cfg && cfg.apiKey);
    } catch (_) {
        return false;
    }
}

const AI_MAX_INPUT_CHARS = 12000;

// Cap the document we hand to the AI. Resumes are short — 12k chars is
// well above any sane resume and keeps the request cheap.
function clipForAi(text) {
    if (!text) return '';
    if (text.length <= AI_MAX_INPUT_CHARS) return text;
    // Keep the head (contact + name) AND the tail (later experience /
    // education sections). Resumes put the most important info at the top
    // and bottom — truncating the middle is the lowest-impact cut.
    const half = Math.floor(AI_MAX_INPUT_CHARS / 2);
    return text.slice(0, half) + '\n\n[…middle of document omitted for brevity…]\n\n' + text.slice(text.length - half);
}

// Strip ```json fences and any preamble the model might emit before/after
// the JSON object. We tolerate partial JSON by extracting the first {...}
// block.
function extractJsonObject(text) {
    if (!text) return null;
    let t = String(text).trim();
    // Drop code-fence wrappers
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Find the first `{` and the matching closing `}`.
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first < 0 || last < 0 || last <= first) return null;
    return t.slice(first, last + 1);
}

const AI_SYSTEM_PROMPT = `You are a resume parser. Given the raw text of a resume (or resume template), output ONLY a single JSON object with these keys:
{
  "summary": string or null,
  "skills": [string, ...],
  "work_experience": [
    {
      "title": string or null,
      "company": string or null,
      "location": string or null,
      "start": string or null,    // free-form e.g. "Jan 2022" or "2022"
      "end": string or null,
      "current": boolean,
      "bullets": [string, ...]
    }
  ],
  "education": [
    {
      "degree": string or null,
      "school": string or null,
      "start": string or null,
      "end": string or null,
      "current": boolean,
      "gpa": string or null  // e.g. "3.8/4.0" — null if not present
    }
  ],
  "section_order": [string, ...]   // the order in which section headings appear
}

Rules:
- Output valid JSON only. No prose, no markdown, no code fences.
- If a field is missing in the document, use null / [] / false.
- Do not invent values that are not in the document.
- Keep bullet text exactly as it appears in the document.
- section_order should contain the section names exactly as they appear (e.g. "Summary", "Skills", "Work Experience").`;

async function detectSectionsWithAi(rawText) {
    if (!rawText || !rawText.trim()) return { error: 'empty document' };

    let provider;
    try {
        provider = getProviderConfig();
    } catch (err) {
        // No API key for the active provider — degrade gracefully so the
        // upload still succeeds with the regex-only output.
        return { error: err.message };
    }

    const userPrompt = `Parse the following resume text and return the JSON object described in the system prompt.\n\n=== RESUME TEXT ===\n${clipForAi(rawText)}\n=== END RESUME ===`;

    try {
        const response = await axios.post(
            provider.apiUrl,
            {
                model: provider.model,
                messages: [
                    { role: 'system', content: AI_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt }
                ],
                // Reasoning models (DeepSeek / MiniMax M2.7) need slack to
                // emit their <think> block before the JSON.
                max_tokens: 4000,
                temperature: 0
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${provider.apiKey}`
                },
                timeout: 60000
            }
        );

        const raw = (response?.data?.choices?.[0]?.message?.content || '').trim();
        if (!raw) return { error: 'empty response from model' };

        // Some reasoning models wrap their final answer in <think>…</think>
        // blocks. The DeepSeek / MiniMax extractors in resumeService.js
        // strip the <think>…</think> wrapper — apply the same here.
        const cleaned = raw
            .replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .trim();
        const jsonStr = extractJsonObject(cleaned);
        if (!jsonStr) return { error: 'no JSON object in model response' };

        let parsed;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
            return { error: `JSON parse failed: ${parseErr.message}` };
        }

        // Coerce + lightly validate the shape so downstream code can rely
        // on it without defensive checks.
        const safe = (v) => (v == null ? null : String(v).trim() || null);
        const safeBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
        const safeArr = (v) => Array.isArray(v) ? v : [];

        return {
            provider: provider.provider,
            model: provider.model,
            summary: safe(parsed.summary),
            skills: safeArr(parsed.skills).map((s) => safe(s)).filter(Boolean),
            work_experience: safeArr(parsed.work_experience).map((j) => ({
                title: safe(j.title),
                company: safe(j.company),
                location: safe(j.location),
                start: safe(j.start),
                end: safe(j.end),
                current: safeBool(j.current),
                bullets: safeArr(j.bullets).map((b) => safe(b)).filter(Boolean)
            })),
            education: safeArr(parsed.education).map((ed) => ({
                degree: safe(ed.degree),
                school: safe(ed.school),
                start: safe(ed.start),
                end: safe(ed.end),
                current: safeBool(ed.current),
                gpa: safe(ed.gpa)
            })),
            section_order: safeArr(parsed.section_order).map((s) => safe(s)).filter(Boolean)
        };
    } catch (err) {
        // Network / timeout / model error — keep regex output.
        return { error: err.response?.data?.error?.message || err.message || 'AI request failed' };
    }
}

module.exports = {
    extractCandidateFromDocx,
    detectSectionsWithAi,
    shouldUseAi,
    // exposed helpers for testing
    _extractEmail: extractEmail,
    _extractPhone: extractPhone,
    _extractDateRange: extractDateRange,
    _splitSections: splitSections,
    _parseExperience: parseExperience
};