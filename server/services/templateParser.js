// =============================================================================
// Resume template parser
// =============================================================================
// Reads a DOCX file (which is just a ZIP), pulls out word/document.xml and
// word/styles.xml, and walks both to produce a compact, normalised JSON
// "style spec" that resumeService.js can consume at generation time.
//
// IMPORTANT — what this parser extracts:
//
//    THIS PARSER EXTRACTS LAYOUT & STYLE ONLY. NEVER CONTENT.
//    The same template always produces the same spec, regardless of whose
//    resume lives inside it. We never persist the candidate's name, job
//    history, education, or any other personal text. Only style metadata
//    (font / size / bold / italic / underline / align / border / indent /
//    spacing / colour) flows through to the renderer.
//
// The parser is intentionally forgiving: it never throws on missing or
// malformed parts of the template — it just falls back to sensible
// defaults. The output spec is *also* stored alongside the template so
// subsequent generations don't have to re-parse.
//
// Output shape (all fields are optional; consumers must default-fill):
// {
//   source: { file, parsed_at },
//   fonts: {
//     heading: 'Calibri',         // rFontsAscii resolved against theme/styles
//     body:    'Calibri',
//     default: 'Calibri'
//   },
//   heading: {
//     // Legacy per-rank heading specs (Heading1 / Heading2 / …).
//     '1': { font, size_half_pt, bold, underline, italic, strike, align, color, highlight, border_bottom, … },
//     '2': { … },
//   },
//   body:    { font, size_half_pt, bold, underline, italic, …, indent_*, space_*, line_spacing_pt, line_rule },
//   name:    { font, size_half_pt, bold, align, … },     // <h1>
//   contact: { font, size_half_pt, align, … },           // contact line
//   list:    { bullet_char, numFmt, indent_*, font, size_half_pt, bold, underline, italic, color, … },
//   slots: {
//     // Slot-aware fingerprints. Renderer routes each piece of generated
//     // content to its corresponding slot. Content text never stored.
//     name:            { font, size_half_pt, bold, underline, italic, strike, color, align, indent_*, space_*, line_spacing_pt, line_rule, border_bottom },
//     contact:         { … },
//     section_heading: { … },
//     position_line:   { … },
//     bullet:          { bullet_char, numFmt, indent_*, font, size_half_pt, bold, underline, italic, color, … },
//     education_line:  { … },
//     skill_line:      { … },
//     summary_text:    { … },
//     body_text:       { … }
//   },
//   section_order: [ 'summary', 'skills', 'experience', 'education' ]  // derived from <h2> order
// }
// =============================================================================

const AdmZip = require('adm-zip');

// --- helpers ---------------------------------------------------------------

function getText(node, tag) {
    const re = new RegExp(`<w:${tag}\\b[^>]*>([\\s\\S]*?)</w:${tag}>`, 'i');
    const m = node.match(re);
    return m ? m[1] : '';
}

// Parse `w:val`, `w:sz` etc. off an XML attribute string.
function wAttr(xml, attr) {
    const re = new RegExp(`w:${attr}="([^"]*)"`, 'i');
    const m = xml.match(re);
    return m ? m[1] : '';
}
// Extract a value from a self-closing XML element like
// `<w:sz w:val="28"/>` — the tag's own w:val (or any other attribute).
// Useful because getText(...) only matches `<w:tag>...</w:tag>` pairs.
function selfClosingAttr(xml, tag, attr) {
    if (!xml) return '';
    const re = new RegExp(`<w:${tag}\\b[^>]*\\bw:${attr}="([^"]*)"`, 'i');
    const m = xml.match(re);
    return m ? m[1] : '';
}
function firstAttr(xml, attr) {
    return wAttr(xml, attr);
}

// Half-points → pt (Word stores sizes in half-points)
function hpToPt(hp) {
    const n = parseInt(hp, 10);
    if (!Number.isFinite(n)) return null;
    return n / 2;
}

// Twips → pt for spacing (1pt = 20 twips)
function twipToPt(t) {
    const n = parseInt(t, 10);
    if (!Number.isFinite(n)) return null;
    return n / 20;
}

// Resolve the font family from an <w:rPr> (run-properties) parent. We
// look inside for the <w:rFonts> element and read its ascii/hAnsi/eastAsia/
// cs attributes in that order of preference. Callers may also pass the
// <w:rFonts> element directly; we detect that and skip the inner lookup.
function resolveFont(rPrOrRFontsXml) {
    if (!rPrOrRFontsXml) return null;
    const isRFontsEl = /^<w:rFonts\b/i.test(rPrOrRFontsXml.trim());
    // rFonts is typically self-closing (<w:rFonts w:ascii="..."/>), so
    // we read attributes straight off it rather than via getText.
    const target = isRFontsEl ? rPrOrRFontsXml : rPrOrRFontsXml;
    return selfClosingAttr(target, 'rFonts', 'ascii')
        || selfClosingAttr(target, 'rFonts', 'hAnsi')
        || selfClosingAttr(target, 'rFonts', 'eastAsia')
        || selfClosingAttr(target, 'rFonts', 'cs');
}

// Resolve the font a paragraph will use. Falls back: pPr → rPr in pPr →
// rPr on first run → docDefaults → null.
function paragraphFont(pPrXml, firstRunRprXml, docDefaultsRpr) {
    const rFontsInPPr = getText(pPrXml || '', 'rPr');
    return resolveFont(rFontsInPPr)
        || resolveFont(firstRunRprXml)
        || resolveFont(docDefaultsRpr);
}

function paragraphSize(pPrXml, firstRunRprXml, docDefaultsRpr) {
    const rPrInPPr = getText(pPrXml || '', 'rPr');
    // <w:sz w:val="N"/> stores size as half-points. We need w:val on the
    // <w:sz> element, not a top-level w:sz attribute (which doesn't
    // exist in the DOCX schema). The element is usually self-closing, so
    // we extract the value directly from rPr via a self-closing-aware
    // regex rather than going through getText(..., 'sz').
    const sz = selfClosingAttr(rPrInPPr, 'sz', 'val')
        || selfClosingAttr(firstRunRprXml || '', 'sz', 'val')
        || selfClosingAttr(docDefaultsRpr || '', 'sz', 'val');
    return hpToPt(sz);
}

function paragraphBold(pPrXml, firstRunRprXml, docDefaultsRpr) {
    const rPrInPPr = getText(pPrXml || '', 'rPr');
    const src = rPrInPPr || firstRunRprXml || docDefaultsRpr || '';
    if (/<w:b\s*\/>/i.test(src)) return true;
    if (/<w:b\s+[^>]*w:val="(false|0)"/i.test(src)) return false;
    if (/<w:b\b/i.test(src)) return true;
    return null;
}

// Detect a single toggle (underline / italic / strike) on the rPr chain.
// Returns true / false / null (null = unspecified, let consumer use default).
function paragraphToggle(pPrXml, firstRunRprXml, docDefaultsRpr, tag) {
    const rPrInPPr = getText(pPrXml || '', 'rPr');
    const src = rPrInPPr || firstRunRprXml || docDefaultsRpr || '';
    const on  = new RegExp(`<w:${tag}\\s*\\/>`, 'i');
    const off = new RegExp(`<w:${tag}\\s+[^>]*w:val="(false|0)"`, 'i');
    const any = new RegExp(`<w:${tag}\\b`, 'i');
    if (on.test(src)) return true;
    if (off.test(src)) return false;
    if (any.test(src)) return true;
    return null;
}

// Read the text colour off the rPr chain. Returns a 6-char hex string or
// null. DOCX stores colours as `w:color w:val="RRGGBB"` or `themeX`; we
// only return the explicit hex.
function paragraphColor(pPrXml, firstRunRprXml, docDefaultsRpr) {
    const rPrInPPr = getText(pPrXml || '', 'rPr');
    const src = rPrInPPr || firstRunRprXml || docDefaultsRpr || '';
    const color = getText(src, 'color');
    if (!color) return null;
    const val = firstAttr(color, 'val');
    if (!val) return null;
    // Skip "auto" (the default) — the renderer doesn't need to set anything
    // explicit in that case.
    if (/^auto$/i.test(val)) return null;
    return val.toUpperCase();
}

// Detect a highlight colour (yellow / green / red / etc.). DOCX encodes
// these as `<w:highlight w:val="yellow"/>`. We return the val as-is; the
// renderer decides whether to translate it to a w:shd shading.
function paragraphHighlight(pPrXml, firstRunRprXml, docDefaultsRpr) {
    const rPrInPPr = getText(pPrXml || '', 'rPr');
    const src = rPrInPPr || firstRunRprXml || docDefaultsRpr || '';
    const hl = getText(src, 'highlight');
    if (!hl) return null;
    const val = firstAttr(hl, 'val');
    if (!val || /^none$/i.test(val)) return null;
    return val.toLowerCase();
}

function paragraphAlign(pPrXml) {
    if (!pPrXml) return null;
    // <w:jc> is written self-closing in DOCX output, so getText()
    // matches an empty inner. Read the val attribute directly off the
    // self-closing tag and only fall back to the pair-tag branch when
    // the tag actually carries content (rare).
    const selfCloseVal = selfClosingAttr(pPrXml, 'jc', 'val');
    if (selfCloseVal) {
        if (selfCloseVal === 'left')   return 'left';
        if (selfCloseVal === 'right')  return 'right';
        if (selfCloseVal === 'center') return 'center';
        if (selfCloseVal === 'both')   return 'justify';
        if (selfCloseVal === 'distribute') return 'justify';
        return selfCloseVal;
    }
    const jc = getText(pPrXml, 'jc');
    if (!jc) return null;
    const val = firstAttr(jc, 'val');
    if (!val) return null;
    if (val === 'left')   return 'left';
    if (val === 'right')  return 'right';
    if (val === 'center') return 'center';
    if (val === 'both')   return 'justify';
    if (val === 'distribute') return 'justify';
    return val;
}

function paragraphSpacing(pPrXml) {
    if (!pPrXml) return null;
    // <w:spacing> is also self-closing in DOCX output. Pull each
    // attribute directly off the tag instead of relying on getText().
    const selfClose = /<w:spacing\b[^>]*\/>/.exec(pPrXml);
    const tagSrc = selfClose ? selfClose[0] : pPrXml;
    if (!/<w:spacing\b/.test(tagSrc)) return null;
    return {
        before_pt: twipToPt(selfClosingAttr(tagSrc, 'spacing', 'before')),
        after_pt:  twipToPt(selfClosingAttr(tagSrc, 'spacing', 'after')),
        line_pt:   twipToPt(selfClosingAttr(tagSrc, 'spacing', 'line')),
        line_rule: selfClosingAttr(tagSrc, 'spacing', 'lineRule') || 'auto'
    };
}

function paragraphIndent(pPrXml) {
    if (!pPrXml) return null;
    const selfClose = /<w:ind\b[^>]*\/>/.exec(pPrXml);
    const tagSrc = selfClose ? selfClose[0] : pPrXml;
    if (!/<w:ind\b/.test(tagSrc)) return null;
    return {
        left_pt:       twipToPt(selfClosingAttr(tagSrc, 'ind', 'left')),
        right_pt:      twipToPt(selfClosingAttr(tagSrc, 'ind', 'right')),
        hanging_pt:    twipToPt(selfClosingAttr(tagSrc, 'ind', 'hanging')),
        first_line_pt: twipToPt(selfClosingAttr(tagSrc, 'ind', 'firstLine'))
    };
}

function paragraphBorderBottom(pPrXml) {
    const pBdr = getText(pPrXml || '', 'pBdr');
    if (!pBdr) return null;
    // <w:bottom> is normally self-closing, so use a self-closing-aware
    // regex rather than getText which needs a closing tag.
    const bottom = (pBdr.match(/<w:bottom\b[^>]*\/>/i) || pBdr.match(/<w:bottom\b[^>]*>([\s\S]*?)<\/w:bottom>/i) || [,''])[0];
    if (!bottom) return null;
    const val = (bottom.match(/\bw:val="([^"]*)"/i) || [,''])[1];
    if (!val || val === 'none') return null;
    const sz = parseInt((bottom.match(/\bw:sz="([^"]*)"/i) || [,''])[1], 10);
    const color = (bottom.match(/\bw:color="([^"]*)"/i) || [,''])[1];
    const space = (bottom.match(/\bw:space="([^"]*)"/i) || [,''])[1];
    return {
        style: val,                                     // single, double, dashed, …
        size_pt: Number.isFinite(sz) ? sz / 8 : null,   // sz is in 1/8pt
        color: color || 'auto',
        space_pt: twipToPt(space)
    };
}

function isBullet(pPrXml) {
    if (!pPrXml) return null;
    // numPr indicates a list paragraph (either bullets or numbered)
    if (/<w:numPr\b/i.test(pPrXml)) {
        // Check numId against the numbering definitions to decide bullet vs number
        return 'list';   // the caller (or numbering.xml walk) can refine to 'bullet' vs 'number'
    }
    return null;
}

function paragraphOutlineLevel(pPrXml) {
    const ol = getText(pPrXml || '', 'outlineLvl');
    if (!ol) return null;
    const v = parseInt(firstAttr(ol, 'val'), 10);
    return Number.isFinite(v) ? v : null;
}

// Build a uniform style fingerprint for the *current* paragraph. Layout
// & style only — never content. The slot capture loop calls this and
// stores the result on whichever slot the paragraph was classified as.
function snapshotParagraphStyle({
    font, size, bold, align,
    effPPr, effFirstRunRpr, docDefaultsRpr,
    border, spacing, indent
}) {
    return {
        font,
        size_half_pt: Math.round(size * 2),
        bold:    bold === true,
        italic:    paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'i') === true,
        underline: paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'u') === true,
        strike:    paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'strike') === true,
        highlight: paragraphHighlight(effPPr, effFirstRunRpr, docDefaultsRpr),
        color:     paragraphColor(effPPr, effFirstRunRpr, docDefaultsRpr),
        align:     align || 'left',
        indent_left_pt:        indent ? indent.left_pt        : null,
        indent_right_pt:       indent ? indent.right_pt       : null,
        indent_hanging_pt:     indent ? indent.hanging_pt     : null,
        indent_first_line_pt:  indent ? indent.first_line_pt  : null,
        space_before_pt:       spacing ? spacing.before_pt   : null,
        space_after_pt:        spacing ? spacing.after_pt    : null,
        line_spacing_pt:       spacing ? spacing.line_pt     : null,
        line_rule:             spacing ? spacing.line_rule   : null,
        border_bottom:         border || null
    };
}

// Map an outline level to a heading rank (1-based). Word's outlineLvl is
// 0-indexed, so outlineLvl=0 → <h1>.
function outlineLevelToRank(level) {
    if (level === null) return null;
    return level + 1;
}

// Match a heading paragraph's plain text against canonical resume
// sections. Returns one of: 'summary', 'skills', 'experience',
// 'education' or null. Mirrors resumeService.SECTION_ORDER so the
// active-section tracker below lines up with the renderer's reorder pass.
const SLOT_SECTION_ALIASES = {
    summary:    ['summary', 'professional summary', 'profile', 'about', 'about me', 'objective', 'career objective', 'overview'],
    skills:     ['skills', 'core skills', 'technical skills', 'key skills', 'core competencies', 'technologies', 'tech stack', 'skill set', 'tools', 'languages'],
    experience: ['experience', 'work experience', 'professional experience', 'employment', 'employment history', 'career history', 'work history', 'positions'],
    education:  ['education', 'academic background', 'qualifications', 'academics']
};
function classifySectionHeadingText(rawText) {
    const t = (rawText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return null;
    for (const key of Object.keys(SLOT_SECTION_ALIASES)) {
        if (SLOT_SECTION_ALIASES[key].includes(t)) return key;
    }
    return null;
}

// Classify a body (non-heading) paragraph into a slot using STRUCTURAL
// signals only — never the literal text. The shape of the line (pipes,
// year ranges, colon prefixes, position relative to a section heading)
// is what decides which slot gets the paragraph's style fingerprint.
//
// Section context wins over generic shape: when we're inside the
// Education section, even a pipe-row gets bucketed as `education_line`
// rather than `position_line` so the slot captures the right style.
function classifyBodySlotByStructure({
    text, bold, hasPipes, hasYearRange, hasYearOnly, hasColonPrefix, activeSection
}) {
    // 1) Section context takes precedence over shape.
    if (activeSection === 'education') return 'education_line';
    if (activeSection === 'summary')   return 'summary_text';
    if (activeSection === 'skills' && hasColonPrefix) return 'skill_line';
    if (activeSection === 'skills')                    return 'body_text';
    // 2) Position line: a bold body line with pipes and a year range —
    //    the classic "Title | Company | Location | 2020 - 2024" row.
    if (bold && hasPipes && hasYearRange)              return 'position_line';
    // 3) Education line: a bold body line with a year range but no pipes.
    if (bold && hasYearRange && !hasPipes)              return 'education_line';
    // 4) Generic body text fallback for any other classified body line.
    return 'body_text';
}

// Test whether a short text line looks like a resume section heading.
// Used as a fallback when the document doesn't use named heading styles
// (e.g. a "simple" template that styles paragraphs inline instead).
// Matches the same canonical sections the AI prompt covers plus common
// variations.
function isLikelySectionHeading(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    if (!t) return false;
    // Reject anything that looks like a sentence (ends with period and
    // contains a verb-like structure).
    if (/[.!?]\s*$/.test(t) && t.length > 25) return false;
    const aliases = [
        'summary', 'professional summary', 'profile', 'about', 'about me',
        'objective', 'career objective', 'overview', 'introduction',
        'skills', 'core skills', 'technical skills', 'key skills',
        'technologies', 'tech stack', 'skill set', 'core competencies',
        'competencies', 'expertise', 'tools', 'languages',
        'experience', 'work experience', 'professional experience',
        'employment', 'employment history', 'career history', 'work history',
        'career', 'positions', 'roles',
        'education', 'academic background', 'qualifications', 'academics',
        'projects', 'personal projects', 'side projects', 'selected projects',
        'certifications', 'certificates', 'licenses', 'awards', 'honors',
        'publications', 'volunteer', 'interests'
    ];
    return aliases.includes(t);
}

// Extract heading text from a paragraph (concatenates all <w:t> nodes).
function paragraphText(pXml) {
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let out = '';
    let m;
    while ((m = re.exec(pXml)) !== null) {
        out += m[1];
    }
    return out.trim();
}

// Try to determine if a paragraph is a bullet list item. Returns the
// bullet character if known.
function bulletChar(pPrXml, numberingMap) {
    const lvl = bulletSpec(pPrXml, numberingMap);
    if (!lvl) return null;
    return lvl.lvl_text || null;
}

// Like bulletChar() but returns the *full* per-level spec — the char,
// the indent/hanging values, font + size. The renderer uses this to
// reproduce the bullet exactly. Returns null when the paragraph is not
// a numbered/bulleted item.
function bulletSpec(pPrXml, numberingMap) {
    if (!pPrXml) return null;
    const numPr = getText(pPrXml, 'numPr');
    if (!numPr) return null;
    // <w:numId> and <w:ilvl> are written self-closing in DOCX output,
    // so firstAttr(getText(...)) returns empty. Read the val attr from
    // the self-closing tag directly.
    const numId = selfClosingAttr(numPr, 'numId', 'val');
    const ilvlRaw = selfClosingAttr(numPr, 'ilvl', 'val');
    const ilvl = parseInt(ilvlRaw, 10) || 0;
    if (!numId) return null;
    return numberingMap?.[numId]?.[ilvl] || null;
}

// --- numbering.xml walker -------------------------------------------------
// Maps numId → [ilvl → '•' / '1.' / …]. We only need the *visual* character
// for our spec; deeper structure isn't useful for resume rendering.
function parseNumbering(zip) {
    const entry = zip.getEntry('word/numbering.xml');
    if (!entry) return {};
    const xml = entry.getData().toString('utf8');

    // num → abstractNumId
    const numMap = {};
    const numRe = /<w:num\b[^>]*>([\s\S]*?)<\/w:num>/gi;
    let nm;
    while ((nm = numRe.exec(xml)) !== null) {
        const inner = nm[1];
        const numId = firstAttr(nm[0], 'numId');
        // <w:abstractNumId> is self-closing in most DOCX output, so going
        // through getText() returns empty. Read the val attribute of the
        // tag itself instead.
        const aId = selfClosingAttr(inner, 'abstractNumId', 'val');
        if (numId && aId != null) numMap[numId] = aId;
    }

    // abstractNum → list of levels, each with a rich per-level spec:
    //   numFmt, lvlText (the literal character/pattern), indent,
    //   hanging, font + size for the bullet marker, and start.
    //
    // The renderer uses this to reproduce the bullet's exact look in
    // the generated DOCX (custom char + indent + per-level font).
    const abstractMap = {};
    const absRe = /<w:abstractNum\b[^>]*>([\s\S]*?)<\/w:abstractNum>/gi;
    let am;
    while ((am = absRe.exec(xml)) !== null) {
        const inner = am[1];
        const aId = firstAttr(am[0], 'abstractNumId');
        if (!aId) continue;
        const lvls = {};
        const lvlRe = /<w:lvl\b[^>]*>([\s\S]*?)<\/w:lvl>/gi;
        let lm;
        while ((lm = lvlRe.exec(inner)) !== null) {
            const lvlInner = lm[1];
            const ilvl = parseInt(firstAttr(lm[0], 'ilvl'), 10);
            if (!Number.isFinite(ilvl)) continue;
            // Inside <w:lvl>, every element is self-closing. Read each
            // attribute via selfClosingAttr() instead of getText().
            const numFmt     = selfClosingAttr(lvlInner, 'numFmt', 'val') || null;
            const lvlTextVal = selfClosingAttr(lvlInner, 'lvlText', 'val') || null;
            const startRaw   = selfClosingAttr(lvlInner, 'start', 'val');
            const start      = parseInt(startRaw, 10);
            // <w:lvlJc> controls alignment of the bullet marker and
            // wrapped text on this level. Capture it so the renderer
            // can reproduce left/center/right-justified lists.
            const lvlJcVal   = selfClosingAttr(lvlInner, 'lvlJc', 'val') || null;
            const lvlJcAlign = lvlJcVal === 'left' ? 'left'
                              : lvlJcVal === 'center' ? 'center'
                              : lvlJcVal === 'right' ? 'right'
                              : lvlJcVal === 'both' || lvlJcVal === 'distribute' ? 'justify'
                              : null;
            const lvlPPr     = getText(lvlInner, 'pPr');
            // <w:ind> is written self-closing in DOCX, so pull the raw
            // tag out of pPr directly instead of going through getText.
            const lvlIndMatch = lvlPPr ? lvlPPr.match(/<w:ind\b[^>]*\/>/) : null;
            const lvlInd     = lvlIndMatch ? lvlIndMatch[0] : '';
            const lvlRpr     = getText(lvlInner, 'rPr');
            lvls[ilvl] = {
                numFmt,
                lvl_text: lvlTextVal,
                start: Number.isFinite(start) ? start : null,
                align: lvlJcAlign,
                indent_left_pt:   lvlInd ? twipToPt(firstAttr(lvlInd, 'left'))      : null,
                indent_hanging_pt: lvlInd ? twipToPt(firstAttr(lvlInd, 'hanging'))   : null,
                indent_first_line_pt: lvlInd ? twipToPt(firstAttr(lvlInd, 'firstLine')) : null,
                font: lvlRpr ? resolveFont(lvlRpr) : null,
                size_half_pt: lvlRpr ? hpToPt(selfClosingAttr(lvlRpr, 'sz', 'val') || '') * 2 : null,
                bold:      lvlRpr ? /<w:b\b/.test(lvlRpr) : null,
                underline: lvlRpr ? /<w:u\b/.test(lvlRpr) : null,
                italic:    lvlRpr ? /<w:i\b/.test(lvlRpr) : null,
                color: lvlRpr ? selfClosingAttr(lvlRpr, 'color', 'val') : null
            };
        }
        abstractMap[aId] = lvls;
    }

    // Combine
    const result = {};
    for (const numId of Object.keys(numMap)) {
        const aId = numMap[numId];
        const lvls = abstractMap[aId];
        if (lvls) result[numId] = lvls;
    }
    return result;
}

// --- main parser ----------------------------------------------------------

// Aggregate the per-paragraph body samples into a single spec. We pick
// the *mode* (most-frequent non-null value) for each field so a couple
// of outlying paragraphs don't poison the spec. Falls back to the
// document defaults when no samples were collected.
function aggregateBodySpec(samples, defaults) {
    const mode = (getter, coerce) => {
        const counts = new Map();
        for (const s of samples) {
            const raw = getter(s);
            const v = coerce ? coerce(raw) : raw;
            if (v === null || v === undefined || v === '') continue;
            const key = typeof v === 'object' ? JSON.stringify(v) : v;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (counts.size === 0) return null;
        let best = null, bestCount = -1;
        for (const [k, n] of counts.entries()) {
            if (n > bestCount) { best = k; bestCount = n; }
        }
        return typeof best === 'string' && counts.size && /^[{\[]/.test(best) ? JSON.parse(best) : best;
    };
    const font        = mode(s => s.font);
    const size        = mode(s => s.size);
    const bold        = mode(s => s.bold);
    const align       = mode(s => s.align);
    const underline   = mode(s => s.underline);
    const italic      = mode(s => s.italic);
    const strike      = mode(s => s.strike);
    const indent      = mode(s => s.indent);
    const spacing     = mode(s => s.spacing);
    const color       = mode(s => s.color);
    return {
        font:        font        || defaults.font,
        size_half_pt: Math.round((size || defaults.size) * 2),
        align:       align       || 'left',
        bold:        bold === true,
        underline:   underline === true,
        italic:      italic === true,
        strike:      strike === true,
        color:       color || null,
        // Indent + spacing are full objects so the renderer can
        // reach for any sub-field (left / hanging / first_line /
        // before / after / line).
        indent_left_pt:    indent ? indent.left_pt   : null,
        indent_right_pt:   indent ? indent.right_pt  : null,
        indent_hanging_pt: indent ? indent.hanging_pt: null,
        indent_first_line_pt: indent ? indent.first_line_pt : null,
        space_before_pt:   spacing ? spacing.before_pt : null,
        space_after_pt:    spacing ? spacing.after_pt  : null,
        line_spacing_pt:   spacing ? spacing.line_pt   : null,
        line_rule:         spacing ? spacing.line_rule : null
    };
}

function parseTemplateDocx(buffer) {
    const zip = new AdmZip(buffer);
    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) {
        throw new Error('Template is not a valid DOCX (missing word/document.xml)');
    }
    const stylesEntry = zip.getEntry('word/styles.xml');
    const stylesXml = stylesEntry ? stylesEntry.getData().toString('utf8') : '';

    // 1. document-level default rPr (the fallback for any unset run).
    //    Hierarchy is: <w:docDefaults><w:rPrDefault><w:rPr>…</w:rPr></w:rPrDefault></w:docDefaults>
    //    We dig through two layers of pair tags (docDefaults → rPrDefault)
    //    to land on the actual <w:rPr> content.
    const docDefaultsBlock = stylesXml ? getText(stylesXml, 'docDefaults') : '';
    const docDefaultsRprDefault = docDefaultsBlock ? getText(docDefaultsBlock, 'rPrDefault') : '';
    const docDefaultsRpr = docDefaultsRprDefault ? getText(docDefaultsRprDefault, 'rPr') : '';
    const defaultFont = resolveFont(docDefaultsRpr) || 'Arial';
    const defaultSize = hpToPt(selfClosingAttr(docDefaultsRpr, 'sz', 'val')) || 11;

    // 2. Style lookup: heading 1, heading 2, heading 3, … → font/size/etc.
    const styleMap = {};
    if (stylesXml) {
        const re = /<w:style\b[^>]*>([\s\S]*?)<\/w:style>/gi;
        let m;
        while ((m = re.exec(stylesXml)) !== null) {
            const inner = m[1];
            const styleId = firstAttr(m[0], 'styleId');
            if (!styleId) continue;
            // Skip table styles / latentStyles — only grab paragraph + run defs
            const rpr = getText(inner, 'rPr');
            const ppr = getText(inner, 'pPr');
            styleMap[styleId.toLowerCase()] = {
                rpr, ppr,
                font: resolveFont(rpr),
                size: hpToPt(selfClosingAttr(rpr, 'sz', 'val')),
                bold: paragraphBold(ppr, rpr, docDefaultsRpr),
                align: paragraphAlign(ppr),
                color: selfClosingAttr(rpr, 'color', 'val'),
                border: paragraphBorderBottom(ppr),
                spacing: paragraphSpacing(ppr),
                indent: paragraphIndent(ppr)
            };
        }
    }

    // 3. Numbering (bullet chars)
    const numberingMap = parseNumbering(zip);

    // 4. Walk paragraphs in document.xml.
    const docXml = docEntry.getData().toString('utf8');
    const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
    const paragraphs = [];
    let pm;
    while ((pm = paraRe.exec(docXml)) !== null) {
        paragraphs.push(pm[0]);
    }

    // 5. Aggregate findings.
    const headings = {};   // rank → style info
    const bodySamples = [];
    const sectionHeadings = [];   // texts of detected section headings (in document order)
    const sectionOrder = [];
    let nameSample = null;

    // Slot captures — every slot stores only layout & style info
    // (font/size/bold/italic/underline/align/indent/spacing/border/colour).
    // Content text (the actual name, the actual job title, etc.) is NEVER
    // persisted in the spec. Re-parsing the same template should always
    // produce the same spec.
    const slots = {
        name:              null,
        contact:           null,
        section_heading:   null,
        position_line:     null,
        bullet:            null,
        education_line:    null,
        skill_line:        null,
        summary_text:      null,
        body_text:         null
    };
    let sectionHeadingSeen = false;     // Did we see any <h2> yet?
    let activeSectionKey = null;        // Which section we're inside?
    let contactSample = null;
    let listSample = null;

    for (const pXml of paragraphs) {
        const inner = pXml.replace(/^<w:p\b[^>]*>/, '').replace(/<\/w:p>$/, '');
        const pPr = getText(inner, 'pPr');
        const firstRun = getText(inner, 'r');
        const firstRunRpr = firstRun ? getText(firstRun, 'rPr') : '';
        // pStyle may be self-closing (e.g. <w:pStyle w:val="Heading2"/>), so
        // extract the val attr directly from pPr rather than going through
        // getText(..., 'pStyle') which only matches the *content* of a pair
        // tag.
        const pStyle = pPr ? (pPr.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i) || [,''])[1] : '';
        const outline = paragraphOutlineLevel(pPr);
        // Pull the named-style definition (e.g. Heading2) from styles.xml
        // so we can resolve font/size/align when the inline run rPr is
        // empty — that's how Word actually does inheritance.
        const styleDef = pStyle ? styleMap[pStyle.toLowerCase()] : null;

        const text = paragraphText(inner);
        if (!text && !pStyle && outline === null && !pPr) continue;

        // Prefer inline properties; fall through to style-defined values.
        const effFirstRunRpr = firstRunRpr || (styleDef?.rpr || '');
        const effPPr = pPr || (styleDef?.ppr || '');

        const font = paragraphFont(effPPr, effFirstRunRpr, docDefaultsRpr) || defaultFont;
        const size = paragraphSize(effPPr, effFirstRunRpr, docDefaultsRpr) || defaultSize;
        const bold = paragraphBold(effPPr, effFirstRunRpr, docDefaultsRpr);
        const align = paragraphAlign(effPPr) || styleDef?.align;
        const spacing = paragraphSpacing(effPPr) || styleDef?.spacing;
        const indent = paragraphIndent(effPPr) || styleDef?.indent;
        const border = paragraphBorderBottom(effPPr) || styleDef?.border;
        const bullet = bulletChar(pPr, numberingMap);

        // Detect "heading rank" via outlineLvl OR via pStyle mapping
        let rank = null;
        if (outline !== null) rank = outlineLevelToRank(outline);
        else if (pStyle) {
            const s = pStyle.toLowerCase();
            const m1 = s.match(/^heading(\d+)$/);
            const m2 = s.match(/^heading(\d+)\s*character$/);
            if (m1) rank = parseInt(m1[1], 10);
            else if (m2) rank = parseInt(m2[1], 10);
        }
        // Fallback: visual heading detection. When the document doesn't
        // use named heading styles (e.g. a "simple" template with plain
        // paragraphs styled inline), we still want to recover the visual
        // hierarchy. A paragraph counts as a heading if it's:
        //   - short (≤ 60 chars)
        //   - either bold OR ≥ 1.4× the body default size
        //   - AND its text matches one of the canonical resume sections
        if (rank === null && text && text.length <= 60) {
            const sizeRatio = size / Math.max(1, defaultSize);
            const isBold = bold === true;
            const isLarger = sizeRatio >= 1.3;
            const matchesSection = isLikelySectionHeading(text);
            if (matchesSection && (isBold || isLarger)) {
                rank = isLarger && sizeRatio >= 1.6 ? 1 : 2;
            }
        }

        // If we know it's a heading, capture.
        if (rank !== null) {
            if (!headings[rank]) {
                // Capture the full inline-style fingerprint of this
                // heading so the renderer can reproduce bold + underline
                // + italic + strike + colour + highlight instead of
                // emitting a plain bold run.
                const underline = paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'u');
                const italic    = paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'i');
                const strike    = paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'strike');
                const color     = paragraphColor(effPPr, effFirstRunRpr, docDefaultsRpr);
                const highlight = paragraphHighlight(effPPr, effFirstRunRpr, docDefaultsRpr);

                headings[rank] = {
                    rank,
                    font,
                    size_half_pt: Math.round(size * 2),
                    bold: bold === true,
                    underline: underline === true,
                    italic: italic === true,
                    strike: strike === true,
                    align: align || 'left',
                    color: color || null,
                    highlight: highlight || null,
                    space_before_pt: spacing?.before_pt ?? null,
                    space_after_pt:  spacing?.after_pt ?? null,
                    border_bottom: border || null,
                    style_id: pStyle || null
                };
            }
            // Track the first non-trivial heading text per rank to derive
            // section ordering.
            const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
            if (normalised) {
                sectionHeadings.push({ rank, text: normalised });
                sectionOrder.push(normalised);
            }
        } else if (rank === 1 && !nameSample && text) {
            nameSample = { font, size, bold, align };
        } else if (bullet) {
            // Capture the full per-level bullet spec on the first list
            // paragraph we see. The renderer reads levels[0..n] to
            // reproduce the bullet's character, indent, hanging, font
            // and size for each nesting depth.
            if (!listSample) {
                const fullSpec = bulletSpec(pPr, numberingMap) || {};
                listSample = {
                    bullet_char: fullSpec.lvl_text || bullet,
                    numFmt: fullSpec.numFmt || null,
                    start: fullSpec.start ?? null,
                    align: fullSpec.align || null,
                    indent_left_pt: fullSpec.indent_left_pt ?? null,
                    indent_hanging_pt: fullSpec.indent_hanging_pt ?? null,
                    indent_first_line_pt: fullSpec.indent_first_line_pt ?? null,
                    font: fullSpec.font || font,
                    size_half_pt: fullSpec.size_half_pt ?? Math.round(size * 2),
                    bold:      fullSpec.bold === true,
                    underline: fullSpec.underline === true,
                    italic:    fullSpec.italic === true,
                    color: fullSpec.color || null
                };
            }
        } else if (text && !bodySamples.length < 6) {
            // Capture the full paragraph-formatting fingerprint for
            // every body run so the spec can reproduce underline /
            // italic / strike / indent / line-spacing exactly. The
            // final body spec aggregates these by frequency below.
            bodySamples.push({
                font, size, bold, align,
                underline: paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'u'),
                italic:    paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'i'),
                strike:    paragraphToggle(effPPr, effFirstRunRpr, docDefaultsRpr, 'strike'),
                indent:    paragraphIndent(effPPr),
                spacing:   paragraphSpacing(effPPr),
                color:     paragraphColor(effPPr, effFirstRunRpr, docDefaultsRpr)
            });
        }

        // ---------- Slot classification (layout-only) -----------
        // We never store the paragraph's text — only the style. Slot
        // detection is positional + structural, not literal. This makes
        // the spec content-agnostic: the same template always produces
        // the same spec regardless of who uploaded it.
        if (rank !== null) {
            // Heading → section_heading slot. We only need one style
            // snapshot (use the first one we see), since all section
            // headings should be visually identical in a real template.
            if (!slots.section_heading) {
                slots.section_heading = snapshotParagraphStyle({
                    font, size, bold, align, effPPr, effFirstRunRpr,
                    docDefaultsRpr, border, spacing, indent
                });
            }
            sectionHeadingSeen = true;
            // Track which section we're now inside (so subsequent body
            // lines can be classified as summary / position / bullet /
            // education / skill etc. by context).
            activeSectionKey = classifySectionHeadingText(text);
        } else if (bullet) {
            // Bullet item → bullet slot (per-level style from numbering).
            if (!slots.bullet) {
                const fullSpec = bulletSpec(pPr, numberingMap) || {};
                slots.bullet = {
                    bullet_char:        fullSpec.lvl_text || bullet,
                    numFmt:             fullSpec.numFmt || null,
                    start:              fullSpec.start ?? null,
                    align:              fullSpec.align || null,
                    indent_left_pt:     fullSpec.indent_left_pt ?? null,
                    indent_hanging_pt:  fullSpec.indent_hanging_pt ?? null,
                    indent_first_line_pt: fullSpec.indent_first_line_pt ?? null,
                    font:               fullSpec.font || font,
                    size_half_pt:       fullSpec.size_half_pt ?? Math.round(size * 2),
                    bold:               fullSpec.bold === true,
                    underline:          fullSpec.underline === true,
                    italic:             fullSpec.italic === true,
                    color:              fullSpec.color || null,
                    space_before_pt:    spacing ? spacing.before_pt : null,
                    space_after_pt:     spacing ? spacing.after_pt  : null,
                    line_spacing_pt:    spacing ? spacing.line_pt   : null,
                    line_rule:          spacing ? spacing.line_rule : null
                };
            }
        } else if (sectionHeadingSeen && text) {
            // After the first section heading, classify each non-heading
            // body paragraph by structural shape (no literal matching of
            // content — only structural cues).
            const slotKey = classifyBodySlotByStructure({
                text, bold, hasPipes: text.includes('|'),
                hasEmail: /[\w@.+-]+@[\w-]+\.[\w.-]+/.test(text),
                hasPhone: /(?:\+?\d[\d\s().-]{7,})/.test(text),
                hasYearRange: /\b(19|20)\d{2}\b.*[-–].*(?:(19|20)\d{2}|Present|present)/.test(text),
                hasYearOnly: /\b(19|20)\d{2}\b/.test(text),
                hasColonPrefix: /^[A-Za-z][\w\s/&-]{1,40}:/.test(text),
                activeSection: activeSectionKey
            });
            if (slotKey && !slots[slotKey]) {
                slots[slotKey] = snapshotParagraphStyle({
                    font, size, bold, align, effPPr, effFirstRunRpr,
                    docDefaultsRpr, border, spacing, indent
                });
            }
        } else if (text && !sectionHeadingSeen) {
            // Pre-heading paragraphs are the name + contact line.
            // The very first paragraph is the name (typically larger +
            // centred); the second is the contact line (centred, smaller,
            // contains email/phone). Use heuristics but never store text.
            if (!slots.name && align === 'center') {
                slots.name = snapshotParagraphStyle({
                    font, size, bold, align, effPPr, effFirstRunRpr,
                    docDefaultsRpr, border, spacing, indent
                });
            } else if (!slots.contact && (align === 'center' || /[\w@.+-]+@[\w-]+\.[\w.-]+/.test(text) || /(?:\+?\d[\d\s().-]{7,})/.test(text))) {
                slots.contact = snapshotParagraphStyle({
                    font, size, bold, align, effPPr, effFirstRunRpr,
                    docDefaultsRpr, border, spacing, indent
                });
            }
        }

        // Heuristic: a centred paragraph with no list/outline that follows
        // the very first paragraph is likely the contact line. We don't
        // try to be too smart — we capture the first candidate.
        if (!contactSample && !rank && !outline && align === 'center' && text) {
            contactSample = { font, size, bold, align };
        }
    }

    // 6. Classify section ordering. Mirrors the rules in resumeService.js.
    const SECTION_ORDER = [
        { key: 'summary',    aliases: ['summary', 'professional summary', 'profile'] },
        { key: 'skills',     aliases: ['skills', 'core skills', 'technical skills', 'key skills', 'core competencies', 'technologies'] },
        { key: 'experience', aliases: ['work experience', 'experience', 'professional experience', 'employment', 'employment history', 'career history'] },
        { key: 'education',  aliases: ['education', 'academic background', 'qualifications'] }
    ];
    function classify(t) {
        const n = t.toLowerCase().replace(/\s+/g, ' ').trim();
        for (let i = 0; i < SECTION_ORDER.length; i++) {
            if (SECTION_ORDER[i].aliases.includes(n)) return SECTION_ORDER[i].key;
        }
        return null;
    }
    const ordered = [];
    const seen = new Set();
    for (const h of sectionHeadings) {
        const k = classify(h.text);
        if (k && !seen.has(k)) { ordered.push(k); seen.add(k); }
    }

    // 7. Compute final spec.
    const heading = {};
    for (const r of Object.keys(headings)) {
        heading[r] = headings[r];
    }

    return {
        source: {
            file: null,                   // filled in by caller
            parsed_at: new Date().toISOString()
        },
        fonts: {
            heading: heading[1]?.font || heading[2]?.font || defaultFont,
            body:    defaultFont,
            default: defaultFont
        },
        heading,
        body: aggregateBodySpec(bodySamples, { font: defaultFont, size: defaultSize }),
        name: nameSample || {
            font: heading[1]?.font || defaultFont,
            size: heading[1]?.size || 16,
            bold: true,
            align: 'center'
        },
        contact: contactSample || {
            font: defaultFont,
            size: 10,
            align: 'center'
        },
        list: listSample || { bullet_char: '•' },
        // Per-slot layout fingerprints. Each slot stores the font /
        // size / bold / italic / underline / alignment / spacing /
        // indent / border of its corresponding paragraph type. Content
        // is NEVER persisted — only style. When the AI generates a
        // resume, the renderer picks the right slot fingerprint for
        // each piece of generated content (name, contact, heading,
        // position line, bullets, education line, skill line, summary,
        // body). When a slot wasn't detected in the template we fall
        // back to its corresponding legacy field (name / contact /
        // heading[1] / list / body).
        slots,
        section_order: ordered
    };
}

module.exports = {
    parseTemplateDocx,
    // Exposed helpers (useful for tests + the admin preview endpoint)
    _resolveFont: resolveFont,
    _hpToPt: hpToPt,
    _twipToPt: twipToPt
};