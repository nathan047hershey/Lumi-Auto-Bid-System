// =============================================================================
// Template renderer
// =============================================================================
// Given a style spec (from templateService) + a chosen font, produce:
//   - a DOCX buffer (via the `docx` package) honouring heading levels,
//     section ordering, borders, bullet characters, spacing, etc.
//   - an inline-CSS <style> string for the PDF route to splice into its
//     print-friendly document so the PDF visually matches the DOCX.
//
// The spec is the same shape produced by templateParser.js and shipped to
// the client by the API — keeping a single source of truth.
// =============================================================================

const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ExternalHyperlink,
    NoBreakHyphen,
    AlignmentType,
    HeadingLevel,
    BorderStyle,
    LevelFormat,
    convertInchesToTwip,
    ShadingType,
    TabStopType,
    TabStopPosition,
    Tab
} = require('docx');

const { collectContactSegments } = require('./resumeContactHeader');
const { asNodeBuffer } = require('../utils/asNodeBuffer');

// --- helpers ---------------------------------------------------------------

function halfPt(pt) { return Math.round((pt || 0) * 2); }
function ptToTwip(pt) { return Math.round((pt || 0) * 20); }

// Convert a spec border descriptor → a docx border config. Returns null when
// the spec doesn't ask for a border (so Paragraph falls back to its default).
function specToBorder(b) {
    if (!b || !b.style || b.style === 'none') return null;
    // Map Word border styles onto docx's BorderStyle enum. Anything unknown
    // falls back to SINGLE — the visual difference is minor and the
    // alternative is throwing on a quirky template.
    const styleMap = {
        single:    BorderStyle.SINGLE,
        double:    BorderStyle.DOUBLE,
        dashed:    BorderStyle.DASHED,
        dotted:    BorderStyle.DOTTED,
        thick:     BorderStyle.THICK,
        'double-wave': BorderStyle.DOUBLE_WAVE,
        wave:      BorderStyle.WAVE
    };
    return {
        style: styleMap[b.style] || BorderStyle.SINGLE,
        size: Math.max(1, Math.round((b.size_pt || 0.75) * 8)),   // 1/8 pt
        color: (b.color && /^[0-9A-Fa-f]{6}$/.test(b.color)) ? b.color : '000000',
        space: ptToTwip(b.space_pt || 1)
    };
}

function alignmentFromSpec(align) {
    if (!align) return AlignmentType.LEFT;
    if (align === 'center') return AlignmentType.CENTER;
    if (align === 'right')  return AlignmentType.RIGHT;
    if (align === 'justify') return AlignmentType.JUSTIFIED;
    return AlignmentType.LEFT;
}

/** Name may be centered; contact must match (never left under a centered name). */
function headerBlockAlign(align) {
    const a = String(align || 'left').toLowerCase();
    if (a === 'right') return 'left';
    if (a === 'center' || a === 'justify') return a;
    return 'left';
}

/** Contact alignment follows the name so the header reads as one block. */
function headerContactAlign(nameSlot, contactSlot) {
    const nameAlign = headerBlockAlign(nameSlot?.align || 'left');
    if (nameAlign === 'center') return 'center';
    if (nameAlign === 'justify') return 'justify';
    return headerBlockAlign(contactSlot?.align || 'left');
}

// Build the top-of-document "header" block: name + contact line. The
// layout & style come from the slot fingerprints (slots.name + slots.contact).
// The user-chosen font always wins — slot-level fonts are overridden so the
// picker is what actually changes the rendered output.
function buildNameAndContact(profile, styleSpec, font) {
    const out = [];
    const nameSlot = getSlotStyle(styleSpec, 'name');
    // Default the name to a sensible 18pt when the parser didn't capture
    // a size (most resume templates don't define an explicit h1 size).
    // 18pt is the conventional resume-title size — equivalent to a
    // slot whose size_half_pt is 36.
    const nameSize = nameSlot?.size_half_pt || 36;
    let nameText = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
    if (nameSlot?.uppercase) nameText = nameText.toUpperCase();
    const nameAlign = headerBlockAlign(nameSlot?.align || 'left');
    out.push(new Paragraph({
        alignment: alignmentFromSpec(nameAlign),
        // Never indent the name — template indents + right-align left a
        // huge empty left gutter that looks like a broken header.
        spacing: { after: ptToTwip(2) },
        children:  [new TextRun({
            text: protectHyphenCompounds(nameText),
            size:   halfPt(nameSize / 2),
            font:   effectiveFont(nameSlot, font),
            bold:   nameSlot?.bold !== false,
            underline: nameSlot?.underline === true,
            italics: nameSlot?.italic === true,
            color:  nameSlot?.color || null
        })]
    }));

    // Honour the user-built template's contact-field order when the
    // spec provides one. The drag-drop builder (userTemplateService)
    // emits `contact_fields: [{id, label, source, visible}]`.
    //
    // LinkedIn / GitHub go on their own line(s) so long URLs don't
    // wrap mid-token under the city|email|phone row. Email + profile
    // URLs are real DOCX ExternalHyperlink fields (clickable).
    const { primary, urls, separator: contactSep } = collectContactSegments(profile, styleSpec);
    const contactSlot = getSlotStyle(styleSpec, 'contact');
    const contactAlign = headerContactAlign(nameSlot, contactSlot);
    const contactSize = contactSlot?.size_half_pt || 20;
    const contactFont = effectiveFont(contactSlot, font);
    const linkColor = '0563C1';
    const contactRun = (text, { link = false } = {}) => new TextRun({
        text: protectHyphenCompounds(text),
        size: halfPt(contactSize / 2),
        font: contactFont,
        bold: contactSlot?.bold === true,
        underline: link || contactSlot?.underline === true ? {} : undefined,
        italics: contactSlot?.italic === true,
        color: link ? linkColor : (contactSlot?.color || null),
        style: link ? 'Hyperlink' : undefined
    });
    const sepRun = () => contactRun(` ${contactSep} `);
    if (primary.length) {
        const children = [];
        primary.forEach((part, i) => {
            if (i > 0) children.push(sepRun());
            if ((part.kind === 'email' || part.kind === 'url') && part.href) {
                children.push(new ExternalHyperlink({
                    children: [contactRun(part.text, { link: true })],
                    link: part.href
                }));
            } else {
                children.push(contactRun(part.text));
            }
        });
        out.push(new Paragraph({
            alignment: alignmentFromSpec(contactAlign),
            spacing: spacingFromSlot(contactSlot, urls.length ? 1 : 5),
            children
        }));
    }
    for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        out.push(new Paragraph({
            alignment: alignmentFromSpec(contactAlign),
            spacing: spacingFromSlot(contactSlot, i === urls.length - 1 ? 5 : 1),
            children: [
                new ExternalHyperlink({
                    children: [contactRun(u.text, { link: true })],
                    link: u.href
                })
            ]
        }));
    }
    return out;
}

// Map an HTML heading level onto the spec's heading[rank]. Returns the spec
// entry, or null when the rank isn't defined (we'll fall back to body).
function getHeadingSpec(styleSpec, rank) {
    if (!styleSpec?.heading) return null;
    return styleSpec.heading[rank] || styleSpec.heading[String(rank)] || null;
}

// Resolve the effective font for a slot. Generation-time font ALWAYS
// wins so preview / DOCX / PDF stay one typeface. Slot fonts from the
// template are only a fallback when no generation font was chosen.
function effectiveFont(slot, userFont) {
    return userFont || slot?.font || 'Arial';
}

/** Collapse "e- commerce" / NBH variants, then keep letter-hyphen-letter
 *  compounds from wrapping via Word's w:noBreakHyphen. */
function collapseBrokenHyphens(text) {
    return String(text || '')
        .replace(/([A-Za-z])[\u00AD\u2010\u2011\-]\s+([A-Za-z])/g, '$1-$2')
        .replace(/([A-Za-z])\s+[\u00AD\u2010\u2011\-]\s*([A-Za-z])/g, '$1-$2');
}

function protectHyphenCompounds(text) {
    // Kept for HTML / callers that still want a single string.
    return collapseBrokenHyphens(text).replace(/([A-Za-z])-([A-Za-z])/g, '$1\u2011$2');
}

/** Split text into TextRuns with real OOXML no-break hyphens between
 *  letter-letter compounds (Word will not wrap mid-token). */
function textRunsWithNoBreakHyphens(text, baseOpts = {}) {
    const cleaned = collapseBrokenHyphens(text);
    if (!cleaned) return [];
    // Split on ASCII / unicode hyphens between letters only — keep other hyphens.
    const pieces = [];
    let buf = '';
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        const isHy = ch === '-' || ch === '\u2011' || ch === '\u2010' || ch === '\u00AD';
        const prev = cleaned[i - 1];
        const next = cleaned[i + 1];
        if (isHy && prev && next && /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) {
            if (buf) pieces.push({ type: 'text', text: buf });
            buf = '';
            pieces.push({ type: 'nbh' });
        } else {
            buf += ch;
        }
    }
    if (buf) pieces.push({ type: 'text', text: buf });

    const runs = [];
    for (const p of pieces) {
        if (p.type === 'nbh') {
            runs.push(new TextRun({
                ...baseOpts,
                text: undefined,
                children: [new NoBreakHyphen()]
            }));
        } else if (p.text) {
            runs.push(new TextRun({ ...baseOpts, text: p.text }));
        }
    }
    return runs.length ? runs : [new TextRun({ ...baseOpts, text: cleaned })];
}

// Style descriptors extracted by the parser. Falls back to the legacy
// name/contact/heading/body/list fields when the slot is missing, so
// templates uploaded before slot extraction still work.
function getSlotStyle(styleSpec, slotName) {
    const direct = styleSpec?.slots?.[slotName];
    if (direct) return direct;
    // Legacy fallback chain.
    const legacy = {
        name:              styleSpec?.name,
        contact:           styleSpec?.contact,
        section_heading:   styleSpec?.heading?.[2] || styleSpec?.heading?.[1],
        position_line:     styleSpec?.body ? { ...styleSpec.body, bold: true } : null,
        bullet:            styleSpec?.list,
        education_line:    styleSpec?.body ? { ...styleSpec.body, bold: true } : null,
        skill_line:        styleSpec?.body,
        summary_text:      styleSpec?.body,
        body_text:         styleSpec?.body
    };
    return legacy[slotName] || null;
}

// Build a complete TextRun from a slot-style descriptor. Centralising
// this keeps slot-aware rendering consistent — every paragraph type
// reads from the same fingerprint.
function runFromSlot(text, slot, font, extra = {}) {
    const f = effectiveFont(slot, font);
    const size = halfPt((slot?.size_half_pt || 22) / 2);
    const opts = {
        size,
        font: f,
        bold:      slot?.bold === true,
        underline: slot?.underline === true,
        italics:    slot?.italic === true,
        ...extra
    };
    if (slot?.strike === true) opts.strike = {};
    if (slot?.color) opts.color = slot.color;
    if (slot?.highlight) opts.shading = { fill: slot.highlight };
    const runs = textRunsWithNoBreakHyphens(text, opts);
    return runs.length === 1 ? runs[0] : runs;
}

function runsFromSlot(text, slot, font, extra = {}) {
    const r = runFromSlot(text, slot, font, extra);
    return Array.isArray(r) ? r : [r];
}

// Build a Paragraph indent config from a slot spec.
function indentFromSlot(slot) {
    if (!slot) return undefined;
    const out = {};
    if (slot.indent_left_pt      != null) out.left      = ptToTwip(slot.indent_left_pt);
    if (slot.indent_right_pt     != null) out.right     = ptToTwip(slot.indent_right_pt);
    if (slot.indent_hanging_pt   != null) out.hanging   = ptToTwip(slot.indent_hanging_pt);
    if (slot.indent_first_line_pt!= null) out.firstLine = ptToTwip(slot.indent_first_line_pt);
    return Object.keys(out).length ? out : undefined;
}

// Build a Paragraph spacing config from a slot spec. Supports both
// `line_spacing_pt` (raw points — set by the template parser) and
// `line_spacing` (unitless multiplier, e.g. 1.35, set by the legacy
// default style spec). The default style spec is what most templates
// resolve to now that template selection has been removed, so reading
// both keeps summary / body paragraphs from collapsing to single-line
// spacing when the user changes font (Georgia at 1.0 line spacing
// reads dramatically tighter than Arial at 1.0 — the multiplier is
// what produces the comfortable default).
function spacingFromSlot(slot, fallbackAfterPt = 2) {
    const out = {};
    if (slot?.space_before_pt != null) out.before = ptToTwip(slot.space_before_pt);
    if (slot?.space_after_pt  != null) out.after  = ptToTwip(slot.space_after_pt);
    // Multiplier-style (1.35 = 135% line height). The DOCX spec expects
    // `line` in 240ths of a line at single spacing (240 = 1.0), so 1.35
    // becomes 324. `lineRule: 'auto'` means the multiplier scales with
    // the font size, which is exactly what we want.
    const multiplier = (typeof slot?.line_spacing === 'number' && slot.line_spacing > 0)
        ? slot.line_spacing
        : null;
    const raw = (typeof slot?.line_spacing_pt === 'number' && slot.line_spacing_pt > 0)
        ? slot.line_spacing_pt / 20   // convert pt → multiplier
        : null;
    const effective = multiplier ?? raw;
    if (effective != null) {
        out.line = Math.max(240, Math.round(effective * 240));
        out.lineRule = (slot?.line_rule && slot.line_rule !== 'auto')
            ? slot.line_rule
            : 'auto';
    }
    return Object.keys(out).length ? out : { after: ptToTwip(fallbackAfterPt) };
}

// Convert a single HTML line into a DOCX paragraph using the spec.
// Build a single "Title | Company | Location | Dates" job-title row as
// a DOCX paragraph with a right-aligned tab stop on the dates segment,
// so the title sits flush-left and the dates flush-right on the same
// line. The 2-column experience layout is opted-in by the template
// builder via styleSpec.experience_row.layout === 'two_column'.
//
// Without this the AI's pipe-separated title row renders as one
// full-width bold string — readable, but conventionally a resume puts
// the dates on the right edge of the page. The tab stop approach is
// the lightest-weight way to get that visual; we don't reach for
// tables because DOCX tables add spacing/edge artefacts that are hard
// to neutralise inside the rest of the document.
// Split a "Title | Company | Location | Dates" string into 4 segments.
// The renderer keeps producing tab-aligned output even when individual
// segments are missing — the AI occasionally drops Location or moves
// Dates to a different position. We do the split on the AI's literal
// ' | ' separator (server-side convention) so the renderer doesn't have
// to know what the user picked in the spec yet. The spec's separator
// then drives how segments are re-joined when displayed inline.
// Date boundary detector: matches the FIRST complete date-like
// substring in the input. Used by splitJobTitleSegments to locate
// where the "dates" portion of a pre-split segment begins.
//
// Accepts:
//   "01/2020"      (MM/YYYY — anchored with leading "\d{2}/")
//   "May 2020"     (Month YYYY)
//   "2020"         (YYYY, only as a fallback when no leading MM/ or Month prefix exists)
//
// IMPORTANT: the alternation ORDER matters. The MM/YYYY form must
// come first so it matches "03/2020" instead of just "2020" — the
// earlier version matched "2020" mid-string and split the date in
// half, leaving "Remote 03/" as the location.
const DATE_START_RE = /(?:\d{2}\/(?:19|20)\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(?:19|20)\d{2}|(?:19|20)\d{2})/;

// Split a "Title | Company | Location | Dates" string into 4 segments.
//
// The renderer keeps producing tab-aligned output even when individual
// segments are missing. Two complications:
//
//   1) When the AI returns the title row as a SINGLE pre-split chunk
//      that ALREADY contains all 4 segments, we just split on `|`.
//   2) When the AI returns it as a sequence of pre-split chunks and
//      the LAST chunk combines location+dates with a SPACE (or any
//      non-pipe separator), the tokeniser merges them with ` | ` so
//      the downstream splitter finds 4 parts. But the AI doesn't
//      always use ` | ` — sometimes it uses ` - ` or just a space,
//      which leaves us with only 3 parts and a merged
//      location+dates that no per-segment split can recover.
//
// To handle case (2) we additionally scan any 3-or-fewer-part result
// for a date substring at the end of the LAST part. If found, we
// split that last part at the date boundary so location and dates
// become independent segments again. This is the only place the
// renderer recovers the 4-segment shape from a malformed AI output.
function splitJobTitleSegments(fullText) {
    const parts = String(fullText || '').split(/\s*\|\s*/);

    // First pass: pick a baseline mapping based on the number of
    // pipe-separated parts.
    let result;
    if (parts.length === 1) result = { title: parts[0] || '', company: '', location: '', dates: '' };
    else if (parts.length === 2) result = { title: parts[0] || '', company: '',         location: '', dates: parts[1] || '' };
    else if (parts.length === 3) result = { title: parts[0] || '', company: parts[1] || '', location: '', dates: parts[2] || '' };
    else result = { title: parts[0] || '', company: parts[1] || '', location: parts[2] || '', dates: parts.slice(3).join(' | ') };

    // Recovery pass: if location is empty but the dates segment
    // ALSO contains a location (i.e. "<location> <dates>" with any
    // non-pipe separator), find the date boundary and split it.
    if (!result.location && result.dates) {
        const m = result.dates.match(DATE_START_RE);
        if (m && m.index > 0) {
            const newLocation = result.dates.substring(0, m.index).trim().replace(/[\s,\-·•|]+$/, '');
            const newDates = result.dates.substring(m.index).trim();
            if (newLocation && newDates) {
                result.location = newLocation;
                result.dates = newDates;
            }
        }
    }
    return result;
}

// Build a TextRun honoring segment-level italic + a base slot style
// (font / size / bold / color / underline). The job title row needs
// per-segment italic, which the existing runFromSlot helper doesn't
// support, so we factor that out here.
function buildSegmentRun(text, slot, font, italic) {
    const opts = {
        size: halfPt((slot?.size_half_pt || 20) / 2),
        font: effectiveFont(slot, font),
        bold: slot?.bold !== false,
        underline: slot?.underline === true,
        italics: !!italic
    };
    if (slot?.color) opts.color = slot.color;
    const runs = textRunsWithNoBreakHyphens(text, opts);
    return runs.length === 1 ? runs[0] : runs;
}

// Helper: build a single inline-row Paragraph from a list of segments.
// Each segment entry: { text, italic, align }. Visible segments only.
//
// Two rendering rules govern the right column:
//   1) All right-aligned segments collapse into a single contiguous
//      block separated by the configured `sep` character, so the
//      user sees "location, dates" instead of two stacked rows.
//   2) The tab that pushes the right column to the right edge is a
//      real `Tab` element (docx renders `<w:tab/>`) — earlier
//      versions put a literal '\t' in the run text and the package
//      silently converted it to whitespace, breaking the column
//      layout and creating an unintended line break.
//
// Separator handling note: the separator character (and its trailing
// space) is emitted as its OWN dedicated TextRun rather than being
// prepended to the next segment's text. Word's run-level whitespace
// handling is strict — when a separator sits at the START of a run
// that has different formatting from its neighbour (e.g. italic
// toggling between location and dates), some viewers strip the
// leading space, producing "Remote,03/2020" instead of "Remote,
// 03/2020". A dedicated separator run guarantees the space is
// preserved regardless of which run formatting bracket sits on
// either side. The separator inherits the formatting of the segment
// it FOLLOWS so the visual styling stays consistent across the
// whole row.
//
// Per-segment italic property is read from `s.italics` (plural —
// matches the docx package's `TextRun` option name). Earlier
// revisions read `s.italic` (singular) which never matched the
// property the caller wrote (`buildTwoColumnJobTitleRow` writes
// `italics` on each segment) so every segment always rendered as
// non-italic regardless of the user's per-segment italic toggle in
// the template builder. The mismatch was silent: the docx package
// happily accepts an `italics: undefined` and emits `<w:i
// w:val="false"/>`, so the rendered DOCX always showed upright
// text and the builder's italic toggle appeared broken.
function buildInlineSegmentRow(segments, sep, slot, font, hasRightSeg, styleSpec) {
    const makeRunOpts = (s) => ({
        size: halfPt((slot?.size_half_pt || 20) / 2),
        font: effectiveFont(slot, font),
        bold: slot?.bold !== false,
        underline: slot?.underline === true,
        italics: !!(s.italics ?? s.italic)
    });
    const makeRun = (s, text) => {
        const opts = makeRunOpts(s);
        if (slot?.color) opts.color = slot.color;
        return textRunsWithNoBreakHyphens(text, opts);
    };
    // Build a separator run. We use the formatting of the segment
    // being followed so italic toggles carry through visually if
    // they happen to differ (rare in practice but harmless).
    const makeSepRun = (s) => {
        const opts = makeRunOpts(s);
        if (slot?.color) opts.color = slot.color;
        return new TextRun({ ...opts, text: sep + ' ' });
    };

    const children = [];
    let firstVisible = true;
    // Collect the visible segments in document order, separating
    // "left/center" from "right" so we can emit them as two
    // contiguous runs: one inline on the left, one inline on the
    // right (joined by `sep`).
    const leftSegs = segments.filter(s => s.text && s.align !== 'right');
    const rightSegs = segments.filter(s => s.text && s.align === 'right');

    // Emit the left/inline side: title, company, location (when not
    // right-aligned), each separated by `sep + ' '` as its own run.
    // The first visible left segment gets no leading separator.
    for (const s of leftSegs) {
        if (!firstVisible) children.push(makeSepRun(s));
        children.push(...makeRun(s, s.text));
        firstVisible = false;
    }

    // Emit a real Tab element to push the right column to the
    // right tab stop. Only needed when at least one right-aligned
    // segment exists.
    if (rightSegs.length) {
        // Wrap the Tab in its own <w:r> block so the run-level
        // formatting inherited from the slot still applies.
        // Without an explicit run wrapper Word sometimes inherits
        // unexpected properties from neighbouring runs, and some
        // older DOCX renderers (older LibreOffice, certain PDF
        // converters) drop an unwrapped <w:tab/> entirely.
        children.push(new TextRun({ children: [new Tab()] }));
    }

    // Emit the right side: each right-aligned segment joined inline
    // by `sep + ' '` (own run per separator). The DOCX tab pushes
    // the joined text to the right column on a single line.
    for (let i = 0; i < rightSegs.length; i++) {
        const seg = rightSegs[i];
        if (i > 0) children.push(makeSepRun(seg));
        children.push(...makeRun(seg, seg.text));
    }

    const leftSeg = segments.find(s => s.text && s.align !== 'right');
    const paraAlign = leftSeg ? leftSeg.align : 'left';
    return new Paragraph({
        alignment: alignmentFromSpec(paraAlign),
        spacing:   spacingFromSlot(slot, 2),
        indent:    indentFromSlot(slot),
        // Tab stop position: derived from the page geometry (Letter
        // width 12240 twips minus the 0.5" left+right margins = 10800
        // twips = 7.5"). The earlier hardcoded 9360 twips (= 6.5")
        // left a 1" gap between the right-aligned column and the
        // page edge, which made the tab look broken in some viewers.
        // Compute it from the spec's margin hints when present so a
        // template with custom margins keeps a flush-right column.
        tabStops:  hasRightSeg ? [{ type: TabStopType.RIGHT, position: rightTabStopPosition(styleSpec) }] : undefined,
        children
    });
}

// Compute the right-aligned tab stop position from the page geometry.
// Falls back to 10800 twips (7.5" — Letter page minus 0.5" margins)
// when the spec doesn't carry margin hints.
function rightTabStopPosition(styleSpec) {
    // Letter = 8.5" × 1440; A4 ≈ 8.27" × 1440.
    const PAGE_W = styleSpec?.page?.paper_size === 'a4'
        ? Math.round(8.27 * 1440)
        : 12240;
    // Default margins match the section declaration in buildDocx
    // (0.5" all around). When the spec overrides a margin we honour
    // it here so the tab stop stays flush with the printable edge.
    const left  = ptToTwip(styleSpec?.page?.margin_left_pt  ?? 0.5 * 72);
    const right = ptToTwip(styleSpec?.page?.margin_right_pt ?? 0.5 * 72);
    return PAGE_W - left - right;
}

// Build the "Title | Company | Location | Dates" job-title row.
//
// The 2-column experience layout (template builder's
// styleSpec.experience_row.layout === 'two_column') splits the AI's
// pipe-separated title into segments and arranges them with a
// right-aligned tab stop so right-aligned segments (typically dates,
// optionally location) sit flush-right while the rest sit flush-left
// on the same line. The template's `experience_row` block adds:
//
//   - per-segment alignment (title/company/location/dates)
//   - per-segment italic
//   - separator character (|, •, ,)
//   - "wrap to next line" toggles (wrap_title_company,
//     wrap_company_location) so a segment can start a NEW paragraph
//     instead of staying inline with the title
//
// When any wrap is on we emit MULTIPLE paragraphs (one per wrap-bound
// group). The renderer never reaches for tables because DOCX tables
// add spacing artefacts that are hard to neutralise inside the rest
// of the document. Returns an ARRAY of Paragraphs (single-element
// when no wraps are on); the caller flattens.
function buildTwoColumnJobTitleRow(inner, styleSpec, font) {
    const slot = getSlotStyle(styleSpec, 'position_line') || styleSpec?.body || {};
    const er = styleSpec?.experience_row || {};
    const sep = (typeof er.separator === 'string' && /^[|•,]$/.test(er.separator)) ? er.separator : '|';
    const showCompany  = er.show_company !== false;
    const showLocation = er.show_location !== false;
    const wrapTC = er.wrap_title_company === true;
    const wrapCL = er.wrap_company_location === true;

    // Per-segment specs. Each carries its text + alignment + italic.
    // The AI returns inline <strong> markup; we strip those markers
    // here because we want per-segment italic to act independently
    // of the AI's bold keywords.
    const segments = splitJobTitleSegments(stripTagsPreserveWhitespace(inner));
    const titleSeg    = { text: segments.title,                                                  align: er.title_align    || 'left',  italics: !!er.title_italic };
    const companySeg  = { text: showCompany  ? segments.company  : '', align: er.company_align  || 'left',  italics: !!er.company_italic };
    const locationSeg = { text: showLocation ? segments.location : '', align: er.location_align || 'left',  italics: !!er.location_italic };
    const datesSeg    = { text: segments.dates,                                                  align: er.dates_align    || 'right', italics: !!er.dates_italic };

    // Wrap semantics (per the user):
    //   wrap_title_company  = ONLY company moves to its own line.
    //                         Title + Location + Dates stay inline on line 1.
    //   wrap_company_location = ONLY location moves to its own line.
    //                         Title + Company + Dates stay inline on line 1.
    //   both wraps on       = Company on line 2, Location on line 3.
    //                         Title + Dates stay inline on line 1.
    //
    // Right-aligned segments ride the right tab stop on whatever line
    // they sit on. When both segments that are normally inline are
    // right-aligned (e.g. dates + location both right), they both
    // land on the right column with the configured separator between
    // them. When only one is right-aligned, it sits flush-right and
    // the other stays inline on the left.
    //
    // The "main" line (line 1) is built first; wrapped segments are
    // emitted as their own paragraphs afterwards.
    const wrapTitleCompany    = wrapTC;
    const wrapCompanyLocation = wrapCL;

    // Build line 1 segments in document order: title + company (if
    // not wrapped) + location (if not wrapped) + dates. Right-aligned
    // segments are kept in document order so the tab character flows
    // correctly between them when both right-aligned.
    const line1Segs = [titleSeg];
    if (!wrapTitleCompany)    line1Segs.push(companySeg);
    if (!wrapCompanyLocation) line1Segs.push(locationSeg);
    line1Segs.push(datesSeg);
    const line1HasRight = line1Segs.some(s => s.text && s.align === 'right');

    const paras = [];
    if (line1Segs.some(s => s.text)) {
        paras.push(buildInlineSegmentRow(line1Segs, sep, slot, font, line1HasRight, styleSpec));
    }

    // Line 2: company when wrap_title_company is on. Company sits on
    // its own line; siblings (location/dates) stay on line 1 because
    // only wrapTC is in scope here.
    if (wrapTitleCompany && companySeg.text) {
        paras.push(buildInlineSegmentRow([companySeg], sep, slot, font, companySeg.align === 'right', styleSpec));
    }
    // Line 3 (or line 2 when wrapTC is off): location when
    // wrap_company_location is on. Same logic — location alone.
    if (wrapCompanyLocation && locationSeg.text) {
        paras.push(buildInlineSegmentRow([locationSeg], sep, slot, font, locationSeg.align === 'right', styleSpec));
    }

    return paras;
}

function looksLikeEducationLine(text) {
    const s = String(text || '');
    const parts = s.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
    // Job titles usually have 4 segments (Title | Co | Loc | Dates).
    // Education is typically 2–3 (Degree | School | Years).
    if (parts.length >= 4) return false;
    if (parts.length < 2) return false;
    const degreeRe = /\b(B\.?\s?S\.?|B\.?\s?A\.?|M\.?\s?S\.?|M\.?\s?A\.?|MBA|Ph\.?\s?D\.?|Bachelor|Master|Associate|Doctor|Diploma|BS|BA|MS|MA)\b/i;
    const uniRe = /\b(University|College|Institute|School|Academy|Polytechnic)\b/i;
    return degreeRe.test(s) || uniRe.test(s);
}

function htmlToParagraph(html, styleSpec, font, sectionHint = null) {
    // Extract text + inline `<strong>` markers. We support a tiny
    // subset on purpose: the AI prompt restricts itself to <h1>, <h2>,
    // <p>, <strong>, <ul>, <li>.
    const inner = html.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '')
                      .replace(/^<li[^>]*>/, '').replace(/<\/li>$/, '')
                      .trim();

    // Detect heading level
    const hMatch = html.match(/^<h([1-6])[^>]*>([\s\S]*)<\/h\1>$/i);
    if (hMatch) {
        const rank = parseInt(hMatch[1], 10);
        const headingSpec = getHeadingSpec(styleSpec, rank) || {};
        const text = stripTags(hMatch[2]);

        // Heading-as-job-title dispatch: many AI runs emit the
        // job-title row as "<h3>Title | Company | Location | Dates</h3>"
        // (semantically a section header under the <h2>Work Experience</h2>).
        // Before falling through to the regular heading render — which
        // would collapse the entire "Title | Company | Remote, US |
        // 09/2022 - Present" string into a SINGLE left-aligned run
        // and never invoke the 2-column / right-align / separator
        // pipeline — detect the pipe-row + year-range pattern here
        // and hand off to buildTwoColumnJobTitleRow when the template
        // has opted into the two-column experience layout.
        //
        // We re-use the exact same pipe/year-range checks as the
        // <p><strong> dispatch below so behaviour is identical
        // regardless of which tag the AI chose.
        if (rank >= 3 && styleSpec?.experience_row?.layout === 'two_column') {
            const monthNameRe = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
            const dateTailRe = '(?:\\d{2}\\/(19|20)\\d{2}|(19|20)\\d{2}|' + monthNameRe + '\\s+(19|20)\\d{2}|Present|present)';
            const isPipeRow = /\|/.test(text);
            const isYearRange = new RegExp(
                '(\\b(19|20)\\d{2}\\b|' + monthNameRe + '\\s+(19|20)\\d{2}).*?[-–]\\s*' + dateTailRe,
                'i'
            ).test(text);
            if (isPipeRow && isYearRange) {
                // buildTwoColumnJobTitleRow wants the INNER content
                // (without the wrapping <h3> tags) — feed it the
                // raw <h3> body so per-segment italic / alignment
                // in the builder still works.
                return buildTwoColumnJobTitleRow(hMatch[2], styleSpec, font);
            }
        }

        // Build the run from the heading spec — passing through bold,
        // underline, italic, strike and highlight so the generated
        // document matches the original template's visual hierarchy.
        const headingText = headingSpec.uppercase ? String(text || '').toUpperCase() : text;
        const runOpts = {
            text: protectHyphenCompounds(headingText),
            bold: headingSpec.bold !== false,
            size: halfPt((headingSpec.size_half_pt || 24) / 2),
            font: effectiveFont(headingSpec, font)
        };
        if (headingSpec.underline === true) runOpts.underline = {};
        if (headingSpec.italic    === true) runOpts.italics   = true;
        if (headingSpec.strike    === true) runOpts.strike    = {};
        if (headingSpec.color)             runOpts.color      = headingSpec.color;
        if (headingSpec.highlight) {
            const hl = headingSpec.highlight;
            // Translate Word's named highlight into shading — the docx
            // npm package exposes `highlight` only on a few builds; we
            // fall back to a 6-char yellow-ish approximation.
            if (/^(yellow|green|red|pink|cyan|magenta|white|lightgray)$/i.test(hl)) {
                runOpts.shading = { fill: hl };
            }
        }
        return new Paragraph({
            alignment: alignmentFromSpec(headingSpec.align),
            spacing: {
                // Prefer explicit heading spacing; for job titles (h3)
                // fall back to experience_row.job_gap_pt so the builder's
                // "space between jobs" control actually lands.
                before: ptToTwip(
                    headingSpec.space_before_pt
                        ?? (rank >= 3 ? (styleSpec?.experience_row?.job_gap_pt ?? 6) : 3)
                ),
                after:  ptToTwip(headingSpec.space_after_pt  ?? 0),
                lineRule: 'auto'
            },
            // Keep the heading glued to its first body paragraph so the
            // visual block doesn't break across page boundaries — that
            // was causing the "big gap" between heading and the next
            // line when an `li` element ended up on the next page.
            keepNext: true,
            // Override the bottom-border `space` to 0 so the underline
            // sits flush against the heading text (the parser usually
            // captures a 1pt space which produces a visible gap between
            // the heading text and the line itself). Style / size /
            // colour are still pulled from the captured spec.
            border: (() => {
                const b = specToBorder(headingSpec.border_bottom);
                if (!b) return undefined;
                return { bottom: { ...b, space: 0 } };
            })(),
            children: [new TextRun(runOpts)]
        });
    }

    // Detect list item. We honour the spec's bullet character +
    // indent + hanging + font + size when present so the generated
    // list matches the template's look instead of always using the
    // default round bullet.
    if (/^<li[^>]*>/i.test(html)) {
        const body = styleSpec?.body || {};
        const list = styleSpec?.list || {};
        const skillSlot = getSlotStyle(styleSpec, 'skill_line');
        const text = stripTags(inner);

        // Pick indent + hanging from the list spec if the user gave
        // us specific values; otherwise defer to the docx defaults.
        const indentOpts = {};
        const hanging = list.indent_hanging_pt;
        const left     = list.indent_left_pt;
        if (hanging != null) indentOpts.hanging = ptToTwip(hanging);
        if (left     != null) indentOpts.left     = ptToTwip(left);

        const bulletChar = (list.bullet_char && /^[•○▪■–—\-*\u2022◦‣]$/.test(list.bullet_char))
            ? list.bullet_char
            : null;

        // The docx npm package's `bullet` field accepts a `character`
        // override. When the spec gives us a non-default char, we use
        // it; otherwise we fall back to Word's default round bullet
        // by passing `level: 0` only. We pass through bold so the
        // bullet marker itself can be bold/italic (matches template).
        const bulletSpecOpts = { level: 0 };
        if (bulletChar) bulletSpecOpts.character = bulletChar;

        // Bullet text alignment takes from the level (lvlJc) if
        // present, otherwise from the body spec, otherwise left.
        const bulletAlign = list.align || body.align;

        // Skill line: always bold category + every skill token (do not
        // require skill_line slot — missing slot used to fall through to
        // generic bullets and leave Python/Ruby unbolded).
        if (looksLikeSkillLineText(text) || (sectionHint === 'skills' && text.includes(':'))) {
            const skillParas = buildSkillParagraphsFromText(text, styleSpec, font);
            if (skillParas && (Array.isArray(skillParas) ? skillParas.length : skillParas)) {
                return skillParas;
            }
        }

        // Generic bullet (experience, education, etc.) — preserve inline
        // <strong> runs so keyword bold survives in DOCX output.
        const bulletBodySpec = {
            ...(body || {}),
            size_half_pt: list.size_half_pt || body.size_half_pt || 20,
            bold: list.bold === true || body.bold === true,
            underline: list.underline === true || body.underline === true,
            italic: list.italic === true || body.italic === true,
            color: list.color || body.color || null
        };
        const runs = parseInlineRuns(inner, bulletBodySpec, font);

        return new Paragraph({
            alignment: alignmentFromSpec(bulletAlign),
            spacing:   { after: ptToTwip(list.space_after_pt ?? body.space_after_pt ?? 2) },
            indent:    Object.keys(indentOpts).length ? indentOpts : undefined,
            bullet:    bulletSpecOpts,
            children: runs
        });
    }

    // Detect paragraph with a strong-only child (job-title / degree rows).
    // We dispatch by structural shape of the inner text — never its literal
    // wording — into the corresponding slot fingerprint so the generated
    // resume mirrors the template's visual hierarchy for each row type.
    const innerText = stripTags(inner);

    // ── Summary: never treat as job-title row (that made the whole paragraph bold)
    if (sectionHint === 'summary') {
        const summarySlot = {
            ...(getSlotStyle(styleSpec, 'summary_text')
                || getSlotStyle(styleSpec, 'body_text')
                || styleSpec?.body
                || {}),
            bold: false
        };
        let summaryInner = inner;
        const wholeStrong = summaryInner.match(/^<strong\b[^>]*>([\s\S]*)<\/strong>$/i);
        if (wholeStrong) summaryInner = wholeStrong[1];
        return new Paragraph({
            alignment: alignmentFromSpec(summarySlot.align || 'left'),
            spacing: spacingFromSlot(summarySlot, 2),
            indent: indentFromSlot(summarySlot),
            children: parseInlineRuns(summaryInner, summarySlot, font)
        });
    }

    // ── Skills: always emit bold category + bold skill tokens via TextRuns
    if (sectionHint === 'skills' || looksLikeSkillLineText(innerText)) {
        const skillParas = buildSkillParagraphsFromText(innerText, styleSpec, font);
        if (skillParas && (Array.isArray(skillParas) ? skillParas.length : skillParas)) {
            return skillParas;
        }
        // Fallback: normalize HTML then parse strong runs
        const normalized = normalizeSkillLineHtml(inner);
        if (/<strong\b/i.test(normalized)) {
            const skillSlot = {
                ...(getSlotStyle(styleSpec, 'skill_line') || styleSpec?.body || {}),
                bold: false
            };
            return new Paragraph({
                alignment: alignmentFromSpec(skillSlot.align || 'left'),
                spacing: spacingFromSlot(skillSlot, 2),
                indent: indentFromSlot(skillSlot),
                children: parseInlineRuns(normalized, skillSlot, font)
            });
        }
    }

    const isBoldRow = /^<p[^>]*><strong>[\s\S]*<\/strong><\/p>$/i.test(html.trim())
                       || /^<strong>[\s\S]*<\/strong>$/i.test(inner);

    // Position-line pattern: pipes + year range (e.g. "Title | Company |
    // Location | 2020 - 2024"). Bold format. Slot = position_line.
    //
    // The AI commonly produces date ranges in any of these shapes:
    //
    //   "01/2020 - Present"        (MM/YYYY - Present)
    //   "01/2020 - 12/2024"        (MM/YYYY - MM/YYYY)
    //   "2020 - 2024"              (YYYY - YYYY)
    //   "May 2020 - March 2024"    (Month YYYY - Month YYYY)
    //   "May 2020 - Present"       (Month YYYY - Present)
    //
    // Earlier versions of this regex only matched the first form
    // (year with literal "Present" at the end anchored the match).
    // The relaxed version accepts `\d{2}/\d{4}`, plain `\d{4}`, OR
    // any spelled-out month + 4-digit year, then either another
    // date expression OR the word "Present" / "present".
    //
    // Note the leading anchor: we only require `\b(19|20)\d{2}\b`
    // to appear SOMEWHERE in the line — many of the formats put the
    // first year mid-string ("March 2020 - March 2024") where a
    // word-boundary regex still matches cleanly.
    const isPipeRow = /\|/.test(innerText);
    const monthName = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
    const dateTail = '(?:\\d{2}\\/(19|20)\\d{2}|(19|20)\\d{2}|' + monthName + '\\s+(19|20)\\d{2}|Present|present)';
    const isYearRange = new RegExp(
        '(\\b(19|20)\\d{2}\\b|' + monthName + '\\s+(19|20)\\d{2}).*?[-–]\\s*' + dateTail,
        'i'
    ).test(innerText);
    const isYearOnly = /\b(19|20)\d{2}\b/.test(innerText);

    let slotName = null;
    const looksLikeEducation = looksLikeEducationLine(innerText)
        || sectionHint === 'education';
    if (isBoldRow && looksLikeEducation && (isYearRange || isYearOnly)) {
        slotName = 'education_line';
    } else if (isBoldRow && isPipeRow && isYearRange) {
        slotName = 'position_line';
    } else if (isBoldRow && isYearRange && !isPipeRow) {
        slotName = 'education_line';
    } else if (
        sectionHint !== 'summary'
        && sectionHint !== 'skills'
        && isBoldRow
        && isPipeRow
        && isYearRange
    ) {
        slotName = 'position_line';
    } else if (
        sectionHint !== 'summary'
        && sectionHint !== 'skills'
        && /^<p[^>]*><strong>/i.test(html.trim())
        && isYearRange
    ) {
        // Job title rows often start with <strong>Title</strong>… — only when dated.
        slotName = 'position_line';
    } else if (
        sectionHint !== 'summary'
        && sectionHint !== 'skills'
        && isBoldRow
        && isPipeRow
    ) {
        slotName = 'position_line';
    } else {
        slotName = 'body_text';
    }

    // 2-column experience row — never apply to education lines.
    const twoColExperience = styleSpec?.experience_row?.layout === 'two_column';
    if (twoColExperience && slotName === 'position_line' && isBoldRow && isPipeRow && isYearRange) {
        // Returns an ARRAY of paragraphs (one when no wraps are on,
        // multiple when wrap_title_company / wrap_company_location
        // are on). htmlToDocxChildren flattens.
        return buildTwoColumnJobTitleRow(inner, styleSpec, font);
    }

    // Fallback skill-line detection when sectionHint was not set.
    if (looksLikeSkillLineText(innerText)) {
        const skillParas = buildSkillParagraphsFromText(innerText, styleSpec, font);
        if (skillParas && (Array.isArray(skillParas) ? skillParas.length : skillParas)) {
            return skillParas;
        }
    }

    const slot = getSlotStyle(styleSpec, slotName) || styleSpec?.body || {};

    // Education meta line: "School | YYYY - YYYY" → school left, dates right.
    const isEduMeta = /\bedu-meta\b/i.test(html)
        || (sectionHint === 'education' && !isBoldRow && /\|/.test(innerText)
            && /\b(19|20)\d{2}\b/.test(innerText));
    if (isEduMeta) {
        const parts = innerText.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
        let school = parts[0] || innerText;
        let years = '';
        if (parts.length >= 2) {
            school = parts.slice(0, -1).join(' | ');
            years = parts[parts.length - 1];
        }
        const metaSlot = {
            ...(getSlotStyle(styleSpec, 'body_text') || styleSpec?.body || {}),
            bold: false
        };
        if (years) {
            return buildInlineSegmentRow(
                [
                    { text: school, align: 'left', italics: false },
                    { text: years, align: 'right', italics: false }
                ],
                '|',
                metaSlot,
                font,
                true,
                styleSpec
            );
        }
        return new Paragraph({
            alignment: alignmentFromSpec(metaSlot.align || 'left'),
            spacing: spacingFromSlot(metaSlot, 2),
            children: textRunsWithNoBreakHyphens(school, {
                size: halfPt((metaSlot.size_half_pt || 20) / 2),
                font: effectiveFont(metaSlot, font),
                bold: false
            })
        });
    }

    // Education degree line: bold degree only (not the whole pipe row).
    if (sectionHint === 'education' && isBoldRow && slotName === 'education_line') {
        const eduSlot = getSlotStyle(styleSpec, 'education_line') || slot;
        // If AI still emitted Degree | School | Years on one bold line,
        // split into degree + meta paragraphs.
        const pipeParts = innerText.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
        if (pipeParts.length >= 3) {
            const degree = pipeParts[0];
            const school = pipeParts[1];
            const years = pipeParts[2];
            const degreePara = new Paragraph({
                alignment: alignmentFromSpec(eduSlot.align || 'left'),
                spacing: { after: ptToTwip(1) },
                children: textRunsWithNoBreakHyphens(degree, {
                    size: halfPt((eduSlot.size_half_pt || styleSpec?.body?.size_half_pt || 20) / 2),
                    font: effectiveFont(eduSlot, font),
                    bold: true
                })
            });
            const metaSlot = {
                ...(getSlotStyle(styleSpec, 'body_text') || styleSpec?.body || {}),
                bold: false
            };
            const metaPara = buildInlineSegmentRow(
                [
                    { text: school, align: 'left' },
                    { text: years, align: 'right' }
                ],
                '|',
                metaSlot,
                font,
                true,
                styleSpec
            );
            return [degreePara, metaPara];
        }
    }

    const runs = parseInlineRuns(inner, slot, font);

    return new Paragraph({
        alignment: alignmentFromSpec(slot.align),
        spacing:   spacingFromSlot(slot, 2),
        indent:    indentFromSlot(slot),
        children:  runs
    });
}

// Decode the HTML entities that the AI / source template commonly emits
// (especially inside <li> bullet text). Without this we end up printing
// the literal string "&amp;" in the generated DOCX instead of "&".
// Done as a single replace chain rather than a per-entity call to keep
// this hot path cheap.
function decodeEntities(s) {
    return String(s || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).trim();
}

/** Split a pipe-jammed skills wall into "Category: skills" rows. */
function splitSkillCategoryLines(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    // "Cat A: a, b | Cat B: c, d" → two rows
    const parts = raw.split(/\s*\|\s*(?=[A-Za-z][^|]{0,50}:\s)/);
    if (parts.length > 1) {
        return parts.map((p) => p.trim()).filter(Boolean);
    }
    return [raw];
}

/** Normalize a skill line: bold category only; plain skill list. */
function normalizeSkillLineHtml(innerHtml) {
    const plain = stripTags(innerHtml).replace(/\s+/g, ' ').trim();
    const m = plain.match(/^(.{1,80}?):\s+(.+)$/);
    if (!m) return String(innerHtml || '');
    const cat = m[1].trim().replace(/:+\s*$/, '');
    const skills = m[2]
        .split(',')
        .map((s) => s.trim().replace(/[.,;:]+$/g, '').trim())
        .filter(Boolean);
    if (!skills.length) return `<strong>${cat}</strong>`;
    return `<strong>${cat}</strong>: ${skills.join(', ')}`;
}

function buildSkillLineParagraph(category, skills, styleSpec, font) {
    const skillSlot = getSlotStyle(styleSpec, 'skill_line') || styleSpec?.body || {};
    const sz = halfPt((skillSlot.size_half_pt || styleSpec?.body?.size_half_pt || 20) / 2);
    const f = effectiveFont(skillSlot, font);
    const color = skillSlot.color || styleSpec?.body?.color || null;
    const cleanedSkills = String(skills || '')
        .split(',')
        .map((s) => s.trim().replace(/[.,;:]+$/g, '').trim())
        .filter(Boolean)
        .join(', ');
    const children = [
        new TextRun({
            text: protectHyphenCompounds(String(category || '').trim().replace(/:+\s*$/, '') + ': '),
            size: sz,
            font: f,
            bold: true,
            color
        }),
        new TextRun({
            text: protectHyphenCompounds(cleanedSkills),
            size: sz,
            font: f,
            bold: false,
            color
        })
    ];
    return new Paragraph({
        alignment: alignmentFromSpec(skillSlot.align || styleSpec?.body?.align || 'left'),
        spacing: spacingFromSlot(skillSlot, 2),
        indent: indentFromSlot(skillSlot),
        children
    });
}

/** Render one or more skill lines; returns Paragraph or Paragraph[]. */
function buildSkillParagraphsFromText(innerText, styleSpec, font) {
    const lines = splitSkillCategoryLines(innerText);
    const paras = [];
    for (const line of lines) {
        const m = line.match(/^(.{1,60}?):\s+(.+)$/);
        if (!m) continue;
        paras.push(buildSkillLineParagraph(m[1], m[2], styleSpec, font));
    }
    return paras.length === 1 ? paras[0] : paras;
}

function looksLikeSkillLineText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    // Single category line or pipe-joined multi-category wall
    if (/^.{1,60}:\s+.+$/.test(t) && !/\b(19|20)\d{2}\b/.test(t)) return true;
    if (/\|\s*[A-Za-z][^|]{0,50}:\s/.test(t)) return true;
    return false;
}

// Like stripTags, but preserves leading + trailing whitespace so the
// spacing around inline <strong> keywords stays intact. Used only by
// parseInlineRuns — every other consumer (heading text, bullet text,
// skill label) wants the trim behaviour. Without this, a paragraph
// like "expertise in <strong>Python</strong>, <strong>TypeScript</strong>,
// and <strong>React</strong>" collapses the commas + spaces between the
// bold keywords because each surrounding chunk gets trimmed.
function stripTagsPreserveWhitespace(s) {
    return decodeEntities(String(s || '').replace(/<[^>]+>/g, ''));
}

// Split `<p><strong>...</strong></p>` into runs honouring <strong> tags.
// Pulls font / size / underline / italic / colour / bold off the body
// spec so generated body text matches the template's run-level style
// (rather than always defaulting to plain text).
//
// TextRun (from the `docx` package) stores its options internally and
// doesn't expose them for mutation, so we keep the run descriptors as
// plain objects during the split pass and only instantiate TextRun at
// the very end with the final (possibly trimmed) text. This lets us
// trim only the leading/trailing whitespace at the very edges of the
// paragraph while preserving every space between bold/non-bold runs.
function parseInlineRuns(html, bodySpec, font) {
    const size = halfPt((bodySpec?.size_half_pt || 20) / 2);
    const f = effectiveFont(bodySpec, font);
    const defaults = {
        bold:      bodySpec?.bold === true,
        underline: bodySpec?.underline === true,
        italics:    bodySpec?.italic === true
    };
    const color = bodySpec?.color || null;

    // Build a list of {text, isBold} chunks from the HTML. We preserve
    // whitespace between chunks so commas/spaces around inline <strong>
    // keywords don't get eaten.
    const chunks = [];
    const re = /<strong>([\s\S]*?)<\/strong>|([\s\S]+?)(?=<strong>|$)/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1] != null ? m[1] : m[2];
        const text = stripTagsPreserveWhitespace(raw);
        if (!text) continue;
        chunks.push({ text, isBold: m[1] != null || defaults.bold });
    }

    // Trim only the very edges of the paragraph — leading whitespace on
    // the first chunk, trailing whitespace on the last chunk — so we
    // drop the outer <p>…</p> wrapper padding without losing the spaces
    // between bold/non-bold keywords.
    if (chunks.length) {
        chunks[0].text = chunks[0].text.replace(/^\s+/, '');
        chunks[chunks.length - 1].text = chunks[chunks.length - 1].text.replace(/\s+$/, '');
    }

    const makeRuns = (chunk) => {
        const opts = {
            size,
            font: f,
            bold:      chunk.isBold,
            underline: defaults.underline,
            italics:    defaults.italic
        };
        if (color) opts.color = color;
        return textRunsWithNoBreakHyphens(chunk.text, opts);
    };

    if (chunks.length) {
        const cleaned = chunks.filter(c => c.text);
        if (cleaned.length) return cleaned.flatMap(makeRuns);
    }

    const fallbackText = stripTagsPreserveWhitespace(html).replace(/^\s+/, '').replace(/\s+$/, '');
    const fallbackOpts = {
        size, font: f,
        bold: defaults.bold, underline: defaults.underline, italics: defaults.italic,
        ...(color ? { color } : {})
    };
    return textRunsWithNoBreakHyphens(fallbackText, fallbackOpts);
}

// Split the AI HTML into header slice + ordered sections, then re-emit
// according to the template's `section_order`. Sections not mentioned in
// the spec preserve their original relative order at the end (matches the
// behaviour of the legacy reorderResumeSections pass).
function reorderBySpec(html, styleSpec) {
    const firstH2Idx = html.search(/<h2\b/i);
    if (firstH2Idx === -1) return html;
    const header = html.substring(0, firstH2Idx);

    const h2Re = /<h2\b[^>]*>[\s\S]*?<\/h2>/gi;
    const blocks = [];
    let lastEnd = firstH2Idx;
    let m;
    while ((m = h2Re.exec(html)) !== null) {
        const start = m.index;
        if (lastEnd < start) blocks[blocks.length - 1].body += html.substring(lastEnd, start);
        const end = h2Re.lastIndex;
        const heading = m[0];
        const innerText = heading.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        blocks.push({ key: classifySection(innerText), heading, body: '' });
        lastEnd = end;
    }
    if (lastEnd < html.length && blocks.length) blocks[blocks.length - 1].body += html.substring(lastEnd);

    // Build a "preferred then default" order. Sections mentioned in
    // `section_order` come first; known-key sections not mentioned
    // appear in their canonical position after.
    const preferred = Array.isArray(styleSpec?.section_order) && styleSpec.section_order.length
        ? styleSpec.section_order
        : [];
    const CANONICAL = ['summary', 'skills', 'experience', 'education'];
    const order = [];
    for (const k of preferred) if (!order.includes(k)) order.push(k);
    for (const k of CANONICAL) if (!order.includes(k)) order.push(k);

    const byKey = {};
    const unknown = [];
    for (const b of blocks) {
        if (b.key) (byKey[b.key] ||= []).push(b);
        else unknown.push(b);
    }

    const ordered = [];
    for (const k of order) {
        const arr = byKey[k];
        if (arr) ordered.push(...arr);
    }
    for (const b of blocks) {
        if (!b.key) ordered.push(b);
    }

    // Apply user-customised section labels. Three sources of overrides,
    // checked in priority order so a rename applied via either UI
    // path flows through to the DOCX:
    //
    //   1) `styleSpec.section_labels[key]` — the new "Section heading
    //      text" card. Explicit, key-based override.
    //   2) `styleSpec.blocks[i].label` for blocks whose `id` matches
    //      the canonical key — the original per-block "Label" input.
    //      Survives if the user renamed a section in the older UI
    //      before upgrading to the new one.
    //   3) The AI's emitted heading text — used as the fallback when
    //      neither override is set so legacy templates keep working
    //      unchanged.
    //
    // Empty/whitespace values are ignored at every layer so a blank
    // input falls through to the next layer instead of forcing the
    // AI's text to disappear.
    const labelsByKey = (styleSpec && styleSpec.section_labels) || {};
    const labelsByBlock = {};
    if (Array.isArray(styleSpec && styleSpec.blocks)) {
        for (const blk of styleSpec.blocks) {
            if (blk && blk.id && typeof blk.label === 'string') labelsByBlock[blk.id] = blk.label;
        }
    }
    const resolveLabel = (key) => {
        if (!key) return null;
        const a = labelsByKey[key];
        if (typeof a === 'string' && a.trim()) return a.trim();
        const b = labelsByBlock[key];
        if (typeof b === 'string' && b.trim() && b.trim().toLowerCase() !== key) return b.trim();
        return null;
    };
    const labelled = ordered.map((b) => {
        const customLabel = resolveLabel(b.key);
        if (b.key && customLabel) {
            const escaped = customLabel
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            return {
                ...b,
                heading: `<h2>${escaped}</h2>`
            };
        }
        return b;
    });

    return header + labelled.map((b) => b.heading + b.body).join('');
}

function classifySection(headingText) {
    const n = (headingText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const map = [
        ['summary',    ['summary', 'professional summary', 'profile']],
        ['skills',     ['skills', 'core skills', 'technical skills', 'key skills', 'core competencies', 'technologies']],
        ['experience', ['work experience', 'experience', 'professional experience', 'employment', 'employment history', 'career history']],
        ['education',  ['education', 'academic background', 'qualifications']]
    ];
    for (const [key, aliases] of map) if (aliases.includes(n)) return key;
    return null;
}

// Two-pass renderer: collect chunks first, then process them with
// stateful look-behind. This is needed because the AI sometimes emits
// the experience title row as 2-3 separate `<p><strong>X</strong></p>`
// chunks (one per segment — title, company, location+dates) instead
// of a single chunk with `' | '` separators. The wrap_title_company +
// per-segment-alignment controls only apply to the COMBINED form, so
// we detect the pre-split pattern and re-combine consecutive chunks
// into a single synthetic chunk before handing them to htmlToParagraph.
//
// Detection rule: a `<p><strong>X</strong></p>` chunk where the inner
// text has NO pipes. When 2-3 such chunks appear back-to-back
// immediately before a `<ul>`, we treat them as one combined job
// title row.
//
// First pass: tokenise + merge pre-split chunks.
function tokeniseHtml(html) {
    const chunkRe = /(<h1\b[^>]*>[\s\S]*?<\/h1>|<h2\b[^>]*>[\s\S]*?<\/h2>|<h3\b[^>]*>[\s\S]*?<\/h3>|<ul\b[^>]*>[\s\S]*?<\/ul>|<p\b[^>]*>[\s\S]*?<\/p>)/gi;
    const chunks = [];
    let m;
    while ((m = chunkRe.exec(html)) !== null) {
        chunks.push(m[1]);
    }
    // Merge pre-split job-title chunks into a single synthetic
    // combined chunk. A "pre-split chunk" is a `<p><strong>X</strong></p>`
    // where X has no pipes. Consecutive pre-split chunks are merged
    // until we hit anything that's NOT a pre-split chunk (typically
    // a `<ul>` or another kind of paragraph).
    const merged = [];
    let i = 0;
    const preSplitRe = /^<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>\s*$/i;
    while (i < chunks.length) {
        const c = chunks[i];
        const m1 = c.match(preSplitRe);
        // Never merge Core Skills rows. Consecutive
        // "<p><strong>Category: a, b</strong></p>" lines used to be
        // joined with " | ", which produced the broken one-line skills
        // wall in DOCX (and made the whole block bold).
        if (m1 && !/\|/.test(c) && !looksLikeSkillLineText(stripTags(c))) {
            // Start a buffer of pre-split title chunks.
            const parts = [stripTags(c)];
            let j = i + 1;
            while (j < chunks.length) {
                const cj = chunks[j];
                const mj = cj.match(preSplitRe);
                if (mj && !/\|/.test(cj) && !looksLikeSkillLineText(stripTags(cj))) {
                    parts.push(stripTags(cj));
                    j++;
                } else {
                    break;
                }
            }
            // If the buffer has >=2 parts (or 1 part that still
            // looks like a title row), merge them. Even a single
            // pre-split chunk benefits from the two-column branch
            // if wrap_title_company would normally separate it.
            if (parts.length >= 2 || (parts.length === 1 && /\b(19|20)\d{2}\b/.test(parts[0]) === false && !/\|/.test(parts[0]))) {
                const combinedText = parts.join(' | ');
                // Wrap as `<p><strong>...</strong></p>` so the
                // downstream htmlToParagraph recognises it as a
                // bold pipe-row candidate.
                merged.push(`<p><strong>${combinedText}</strong></p>`);
                i = j;
                continue;
            }
            // Single-segment buffer without enough info to merge —
            // fall through and emit each chunk individually.
        }
        merged.push(c);
        i++;
    }
    return merged;
}

// Walk the HTML and emit paragraphs + lists. <ul>…</ul> blocks are emitted
// as a list with one Paragraph per <li>.
function htmlToDocxChildren(html, styleSpec, font) {
    const out = [];
    // First pass: tokenise + merge pre-split title chunks so the
    // downstream code only sees the canonical "Title | Company |
    // Location | Dates" shape.
    const chunks = tokeniseHtml(html);
    // Skip <h1> + all leading contact <p>s (city|email|phone, then
    // LinkedIn / GitHub on their own lines). buildNameAndContact
    // already emits those from the profile.
    let skippingHeader = true;
    let sectionHint = null;
    for (const chunk of chunks) {
        if (/^<h1\b/i.test(chunk)) {
            skippingHeader = true;
            sectionHint = null;
            continue;
        }
        if (/^<h2\b/i.test(chunk)) {
            skippingHeader = false;
            const label = String(chunk).replace(/<[^>]+>/g, ' ').toLowerCase();
            if (/education|academic|qualifications/.test(label)) sectionHint = 'education';
            else if (/experience|employment|work history/.test(label)) sectionHint = 'experience';
            else if (/skill/.test(label)) sectionHint = 'skills';
            else if (/summary|profile|objective/.test(label)) sectionHint = 'summary';
            else sectionHint = null;
        }
        if (skippingHeader && /^<p\b/i.test(chunk)) {
            const isBoldWrapped = /<strong[\s>]/i.test(chunk);
            const looksLikeContact = !isBoldWrapped && /@|https?:\/\/|linkedin\.com|github\.com|\d{3}[-.\s]?\d{3}/.test(chunk);
            if (looksLikeContact) continue;
            skippingHeader = false;
        } else if (skippingHeader && !/^<h2\b/i.test(chunk)) {
            skippingHeader = false;
        }
        // Work-summary preamble: when the template enables
        // experience_row.work_summary and the current chunk is a
        // <p><em>...</em></p> (the AI's per-job work summary shape),
        // emit it directly as an italic paragraph and skip the
        // default htmlToParagraph path so the text doesn't render
        // twice. The default path doesn't honour <em> so without
        // this hook the same sentence would appear as both a plain
        // body paragraph AND an italic preamble.
        if (styleSpec?.experience_row?.work_summary === true) {
            const emMatch = chunk.match(/^<p[^>]*>\s*<em[^>]*>([\s\S]*?)<\/em>\s*<\/p>\s*$/i);
            if (emMatch) {
                out.push(buildWorkSummaryParagraph(emMatch[1], styleSpec, font));
                continue;
            }
        }
        if (/^<ul\b/i.test(chunk)) {
            const items = chunk.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
            for (const li of items) out.push(htmlToParagraph(li, styleSpec, font, sectionHint));
            continue;
        }
        const para = htmlToParagraph(chunk, styleSpec, font, sectionHint);
        // htmlToParagraph may return a single Paragraph or an array
        // (two-column experience row with wraps). Flatten either way
        // so the children list always contains Paragraph objects.
        if (Array.isArray(para)) {
            for (const p of para) out.push(p);
        } else {
            out.push(para);
        }
    }
    return out;
}

// Render a per-job work summary as a single italicized paragraph
// above the bullet list. The AI emits "<p><em>...</em></p>" when
// experience_row.work_summary is true. We deliberately do NOT treat
// the line as a bullet (the spec says "no bullet points") and we
// ignore any <strong> inside the summary — it should always be a
// soft italic sentence, never bolded.
function buildWorkSummaryParagraph(text, styleSpec, font) {
    const slot = styleSpec?.body || {};
    const inner = decodeEntities(text);
    const runOpts = {
        text: protectHyphenCompounds(inner),
        size: halfPt((slot.size_half_pt || 20) / 2),
        font: effectiveFont(slot, font),
        bold: false,
        italics: true
    };
    if (slot.color) runOpts.color = slot.color;
    return new Paragraph({
        alignment: alignmentFromSpec(slot.align),
        spacing: { after: ptToTwip(2) },
        children: [new TextRun(runOpts)]
    });
}

// Public: build a DOCX buffer from raw resume HTML + profile + style spec + font.
async function buildDocx({ resumeHtml, profile, styleSpec, font }) {
    const ordered = reorderBySpec(resumeHtml, styleSpec);
    const headerChildren = buildNameAndContact(profile, styleSpec, font);
    const bodyChildren   = htmlToDocxChildren(ordered, styleSpec, font);

    // Margins come from the template builder (points → inches). Default
    // 36pt = 0.5". Clamp matches sanitizeSpec so a bad saved value
    // can't blow out the page.
    const ptToIn = (pt, fallbackIn) => {
        const n = Number(pt);
        if (!Number.isFinite(n)) return fallbackIn;
        return Math.max(0.25, Math.min(1.5, n / 72));
    };
    const page = styleSpec?.page || {};
    const marginTop = ptToIn(page.margin_top_pt, 0.5);
    const marginBottom = ptToIn(page.margin_bottom_pt, 0.5);
    const marginLeft = ptToIn(page.margin_left_pt, 0.5);
    const marginRight = ptToIn(page.margin_right_pt, 0.5);
    const isA4 = page.paper_size === 'a4';
    const pageWidthIn = isA4 ? 8.27 : 8.5;
    const pageHeightIn = isA4 ? 11.69 : 11;

    const doc = new Document({
        creator: 'Job Apply Platform',
        title: `Resume — ${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        styles: {
            default: {
                document: { run: { font, size: halfPt((styleSpec?.body?.size_half_pt || 20) / 2) } }
            }
        },
        sections: [{
            properties: {
                page: {
                    size: {
                        width: convertInchesToTwip(pageWidthIn),
                        height: convertInchesToTwip(pageHeightIn)
                    },
                    margin: {
                        top:    convertInchesToTwip(marginTop),
                        bottom: convertInchesToTwip(marginBottom),
                        left:   convertInchesToTwip(marginLeft),
                        right:  convertInchesToTwip(marginRight),
                        header: convertInchesToTwip(0.3),
                        footer: convertInchesToTwip(0.3),
                        gutter: 0
                    }
                }
            },
            children: [...headerChildren, ...bodyChildren]
        }]
    });
    return asNodeBuffer(await Packer.toBuffer(doc));
}

// Public: like `buildDocx` but for the admin template preview. It uses
// a placeholder candidate so the same slot-aware DOCX renderer can run
// without a real profile on file. We rebuild the HTML with `<header>`
// + slot-class wrappers so a later `mammoth convertToHtml` step
// translates the document into a faithful HTML mirror.
async function buildPreviewDocx({ styleSpec, font, resumeHtml }) {
    const ordered = reorderBySpec(resumeHtml || buildMockResumeHtml(styleSpec, font), styleSpec);
    const profile = {
        first_name: 'First', last_name: 'Last',
        email: 'email@example.com', phone: '+1 (555) 000-0000',
        city: 'City', state: 'ST'
    };
    return buildDocx({ resumeHtml: ordered, profile, styleSpec, font });
}

// Public: build a CSS string that mirrors the DOCX spec — embedded in the
// PDF route's print-friendly template so DOCX and PDF look the same.
//
// Slot-aware: each parsed slot produces a CSS rule scoped to a `.slot-*`
// class the mock HTML emits. That keeps alignment, indent, line-spacing,
// border, color and decoration all flowing from the parser spec into the
// rendered preview instead of a one-size-fits-all font.
function buildPdfCss(styleSpec, font) {
    // Helper: turn a slot fingerprint into a CSS declaration list.
    // Returns '' when nothing meaningful is present so we don't emit
    // empty `font-family: undefined` declarations.
    function slotToCss(slot) {
        if (!slot) return '';
        const decls = [];
        // User-selected font always wins. The slot-level font (if any)
        // is included as an earlier preference only when it's NOT the
        // default Arial fallback — otherwise it gets ignored and we
        // emit just the user font. This matches the DOCX path where
        // effectiveFont() returns userFont || slot.font.
        const userFontFirst = font ? `"${font}", ${slot.font ? `"${slot.font}", ` : ''}Arial, sans-serif` : (slot.font ? `"${slot.font}", Arial, sans-serif` : '');
        if (userFontFirst) decls.push(`font-family:${userFontFirst}`);
        if (slot.size_half_pt) decls.push(`font-size:${(slot.size_half_pt / 2)}pt`);
        if (slot.bold === true)  decls.push('font-weight:bold'); else if (slot.bold === false) decls.push('font-weight:normal');
        if (slot.italic === true) decls.push('font-style:italic');
        if (slot.underline === true) decls.push('text-decoration:underline');
        if (slot.strike === true) decls.push('text-decoration:line-through');
        if (slot.color) decls.push(`color:#${slot.color}`);
        if (slot.highlight) decls.push(`background:${slot.highlight}`);
        if (slot.align) decls.push(`text-align:${slot.align}`);
        if (slot.indent_left_pt != null)      decls.push(`margin-left:${slot.indent_left_pt}pt`);
        if (slot.indent_right_pt != null)     decls.push(`margin-right:${slot.indent_right_pt}pt`);
        if (slot.indent_hanging_pt != null)   decls.push(`padding-left:${slot.indent_hanging_pt}pt; text-indent:-${slot.indent_hanging_pt}pt`);
        if (slot.indent_first_line_pt != null) decls.push(`text-indent:${slot.indent_first_line_pt}pt`);
        if (slot.space_before_pt != null) decls.push(`margin-top:${slot.space_before_pt}pt`);
        if (slot.space_after_pt  != null) decls.push(`margin-bottom:${slot.space_after_pt}pt`);
        if (slot.line_spacing_pt != null) {
            // line_spacing_pt stored as points; CSS line-height unitless
            // ratio relative to font-size is more portable. We send a
            // ratio because the user's mock HTML carries the same
            // font-size via this same CSS so they cancel correctly.
            decls.push(`line-height:${(slot.line_spacing_pt / Math.max(1, (slot.size_half_pt || 22) / 2)).toFixed(2)}`);
        }
        if (slot.border_bottom && slot.border_bottom.style && slot.border_bottom.style !== 'none') {
            const b = slot.border_bottom;
            decls.push(`border-bottom:${b.size_pt || 0.75}pt ${b.style || 'solid'} #${b.color || '000000'}`);
            decls.push(`padding-bottom:${b.space_pt || 1}pt`);
        }
        return decls.join('; ') + ';';
    }

    const slots = styleSpec?.slots || {};
    // Legacy fallback chain so templates uploaded before slot extraction
    // still get sensible styling.
    const legacy = styleSpec || {};
    const h = legacy.heading || {};
    const list = legacy.list || { bullet_char: '•' };

    const nameDeclsRaw     = slotToCss(slots.name)        || slotToCss(legacy.name)        || 'text-align:left; font-weight:bold;';
    const contactDeclsRaw  = slotToCss(slots.contact)     || slotToCss(legacy.contact)     || 'text-align:left; font-size:10pt;';
    // Drop template indents; sync contact align with name (centered name
    // must not sit above left-aligned contact).
    const scrubHeaderCss = (css) => String(css || '')
        .replace(/text-align:\s*right\s*;?/gi, 'text-align:left;')
        .replace(/margin-left:\s*[^;]+;?/gi, '')
        .replace(/padding-left:\s*[^;]+;?/gi, '')
        .replace(/text-indent:\s*[^;]+;?/gi, '');
    let nameDecls = scrubHeaderCss(nameDeclsRaw);
    let contactDecls = scrubHeaderCss(contactDeclsRaw);
    const nameAlignM = nameDecls.match(/text-align:\s*(center|left|justify)/i);
    const nameAlign = (nameAlignM && nameAlignM[1].toLowerCase()) || 'left';
    if (nameAlign === 'center' || nameAlign === 'justify') {
        if (/text-align:\s*\w+/i.test(contactDecls)) {
            contactDecls = contactDecls.replace(/text-align:\s*\w+/i, `text-align:${nameAlign}`);
        } else {
            contactDecls = `text-align:${nameAlign}; ${contactDecls}`.trim();
        }
    }
    const sectionDecls     = slotToCss(slots.section_heading) || slotToCss(h[2] || h[1]);
    const positionDecls    = slotToCss(slots.position_line);
    const educationDecls   = slotToCss(slots.education_line);
    const skillDecls       = slotToCss(slots.skill_line);
    const summaryDecls     = slotToCss(slots.summary_text);
    const bodyDecls        = slotToCss(slots.body_text);

    // Bullet slot has additional per-level indent + hanging + custom char.
    let bulletDecls = '';
    let bulletListStyle = list.bullet_char || '•';
    if (slots.bullet) {
        const b = slots.bullet;
        const decls = [];
        if (b.font || font) decls.push(`font-family:${font ? `"${font}", ${b.font ? `"${b.font}", ` : ''}Arial, sans-serif` : `"${b.font}", Arial, sans-serif`}`);
        if (b.color)    decls.push(`color:#${b.color}`);
        if (b.indent_left_pt != null)     decls.push(`margin-left:${b.indent_left_pt}pt`);
        if (b.indent_hanging_pt != null)   decls.push(`padding-left:${b.indent_hanging_pt}pt`);
        if (b.space_before_pt != null)    decls.push(`margin-top:${b.space_before_pt}pt`);
        if (b.space_after_pt  != null)    decls.push(`margin-bottom:${b.space_after_pt}pt`);
        bulletDecls = decls.length ? `ul.slot-bullet li, .slot-bullet > li { ${decls.join('; ')}; }` : '';
        if (b.bullet_char) bulletListStyle = b.bullet_char;
    }

    return `
        /* Slot-aware preview / PDF styling — mirrors DOCX template slots. */
        body { font-family: "${font || 'Arial'}", Arial, sans-serif; color: #000; hyphens: none; -webkit-hyphens: none; word-break: normal; overflow-wrap: break-word; }
        body, body * { font-family: "${font || 'Arial'}", Arial, sans-serif !important; }
        h1.slot-name, h1 { ${nameDecls} margin-top: 0; margin-bottom: 2pt; }
        p.slot-contact, header.resume-head > p { ${contactDecls || 'text-align:center; font-size:10pt;'} margin-top: 0; margin-bottom: 1pt; }
        header.resume-head { margin-bottom: 8pt; }
        h2, .slot-section_heading { ${sectionDecls} margin-top: 10pt; margin-bottom: 4pt; }
        .slot-position_line, p.slot-position_line > strong { ${positionDecls || 'font-weight:bold;'} }
        .slot-education_line, p.slot-education_line, p.slot-education_line > strong {
            ${educationDecls || 'font-weight:bold;'}
            display: block;
            text-align: left;
            margin-bottom: 1pt;
        }
        p.edu-meta, .slot-education_meta {
            display: flex;
            justify-content: space-between;
            gap: 1rem;
            font-weight: normal;
            margin-top: 0;
            margin-bottom: 6pt;
        }
        span.nbh, .nbh { white-space: nowrap; }
        /* Skill rows: bold category label only; skill names normal weight. */
        .slot-skill_line, li.slot-skill_line {
            ${(skillDecls || '').replace(/font-weight\s*:\s*[^;]+;?/gi, '')}
            font-weight: normal;
        }
        .slot-skill_line > strong:first-child,
        li.slot-skill_line > strong:first-child {
            font-weight: 700;
        }
        /* Summary body stays normal weight; inline <strong> still bolds keywords. */
        .slot-summary_text, p.slot-summary_text { ${(summaryDecls || '').replace(/font-weight\s*:\s*bold\s*;?/gi, 'font-weight:normal;')} }
        .slot-summary_text strong, p.slot-summary_text strong { font-weight:bold; }
        .slot-body_text, p.slot-body_text { ${bodyDecls} }
        ${bulletDecls}
        ul { list-style-type: '${String(bulletListStyle || '•').replace(/'/g, "\\'")}'; margin: 0 0 4pt 0; padding-left: 18pt; }
        p { margin: 0 0 ${(legacy.body?.space_after_pt ?? 2)}pt 0; }
        li { margin: 0 0 ${(legacy.body?.space_after_pt ?? 2)}pt 0; page-break-inside: avoid; }
        h1, h2 { page-break-after: avoid; }
        /* Contact email / LinkedIn / GitHub — real clickable links */
        a { color: #0563C1; text-decoration: underline; }
        a:visited { color: #0563C1; }
    `;
}

// ============================================================
// Mock-content builder for the admin template preview
// ============================================================
// The preview endpoint asks the renderer to produce a fully-styled
// resume from MOCK content so admins can verify "this template will
// render like this" before publishing. Every emitted element carries
// a `slot-*` class that the matching CSS in `buildPdfCss` targets, so
// alignment / indent / font / spacing / border / decoration all flow
// from the parsed spec into the rendered preview.
//
// The mock always contains the canonical sections (Summary, Skills,
// Experience, Education) so every slot is exercised — even if the
// template's section_order is sparse.
function buildMockResumeHtml(styleSpec, font) {
    const CANONICAL = ['summary', 'skills', 'experience', 'education'];
    const slots = styleSpec?.slots || {};
    const legacy = styleSpec || {};

    // Slot-aware inline-style fallback: if a slot has a value we render
    // it as inline CSS. The PDF view in the preview route emits a
    // stylesheet too, but inline style is the safety net so the layout
    // stays intact even if the stylesheet fails to load (browser cache,
    // CSP, etc.).
    function inlineStyle(slot) {
        if (!slot) return '';
        const decls = [];
        // User-selected font always wins. Slot-level font is included as
        // a preference only when it's distinct from the user font, so
        // the picker's choice is what actually renders.
        if (font || slot.font) {
            const parts = [];
            if (font) parts.push(`"${font}"`);
            if (slot.font && slot.font !== font) parts.push(`"${slot.font}"`);
            parts.push('Arial', 'sans-serif');
            decls.push(`font-family:${parts.join(', ')}`);
        }
        if (slot.size_half_pt) decls.push(`font-size:${(slot.size_half_pt / 2)}pt`);
        if (slot.bold) decls.push('font-weight:bold');
        if (slot.italic) decls.push('font-style:italic');
        if (slot.underline) decls.push('text-decoration:underline');
        if (slot.strike) decls.push('text-decoration:line-through');
        if (slot.color) decls.push(`color:#${slot.color}`);
        if (slot.highlight) decls.push(`background:${slot.highlight}`);
        if (slot.align) decls.push(`text-align:${slot.align}`);
        if (slot.indent_left_pt != null) decls.push(`margin-left:${slot.indent_left_pt}pt`);
        if (slot.space_before_pt != null) decls.push(`margin-top:${slot.space_before_pt}pt`);
        if (slot.space_after_pt  != null) decls.push(`margin-bottom:${slot.space_after_pt}pt`);
        return decls.join('; ');
    }

    const nameStyle  = inlineStyle(slots.name)        || inlineStyle(legacy.name);
    const contactStyle = inlineStyle(slots.contact)   || inlineStyle(legacy.contact);
    const sectionStyle = inlineStyle(slots.section_heading) || inlineStyle(legacy.heading?.[2] || legacy.heading?.[1]);
    const positionStyle = inlineStyle(slots.position_line);
    const educationStyle = inlineStyle(slots.education_line);
    const skillStyle    = inlineStyle(slots.skill_line);
    const summaryStyle  = inlineStyle(slots.summary_text);
    const bodyStyle     = inlineStyle(slots.body_text);
    const bulletStyle   = inlineStyle(slots.bullet);

    // Section order: union of the parsed order with the canonical four
    // so the preview always exercises every slot type the parser
    // knows about.
    const orderedFromSpec = Array.isArray(styleSpec?.section_order) && styleSpec.section_order.length
        ? styleSpec.section_order
        : [];
    const ordered = [...orderedFromSpec];
    for (const key of CANONICAL) {
        if (!ordered.includes(key)) ordered.push(key);
    }

    const HEADING_LABELS = {
        summary:    'Summary',
        skills:     'Skills',
        experience: 'Work Experience',
        education:  'Education'
    };
    const headingLabel = (key) => (HEADING_LABELS[key] || key.replace(/^./, c => c.toUpperCase()));

    function styleAttr(s) { return s ? ` style="${s}"` : ''; }
    function cls(name) { return ` slot-${name}`; }

    // ----- Mock body content -----
    const out = [];

    // Name + contact header. Wrap in <header class="resume-head"> so CSS
    // can scope h1 + p without relying on adjacent-sibling selectors
    // that fail when whitespace / comments separate them in browsers.
    out.push(`<header class="resume-head">`);
    out.push(`<h1 class="slot-name"${styleAttr(nameStyle)}>First Last</h1>`);
    out.push(`<p class="slot-contact"${styleAttr(contactStyle)}>City, ST | email@example.com | +1 (555) 000-0000</p>`);
    out.push(`<p class="slot-contact"${styleAttr(contactStyle)}>https://linkedin.com/in/example</p>`);
    out.push(`</header>`);

    // Section renderers keyed by section. Each emits (h2 + body) with
    // the matching slot-* classes so CSS can target per-section style.
    function pushSection(key, bodyHtml) {
        out.push(`<section class="resume-section${cls(key)}">`);
        out.push(`<h2 class="slot-section_heading"${styleAttr(sectionStyle)}>${headingLabel(key)}</h2>`);
        out.push(bodyHtml);
        out.push(`</section>`);
    }

    if (ordered.includes('summary')) {
        pushSection('summary',
            `<p class="slot-summary_text"${styleAttr(summaryStyle || bodyStyle)}>Senior software engineer with seven years of experience building production web services. Comfortable owning a feature end-to-end, from talking to stakeholders through on-call rotations. Most recent work focuses on real-time pipelines and developer tooling.</p>`
        );
    }
    if (ordered.includes('skills')) {
        const skillLines = [
            '<li class="slot-skill_line"><strong>Languages:</strong> TypeScript, JavaScript, Python, Go, Rust</li>',
            '<li class="slot-skill_line"><strong>Frameworks:</strong> React, Next.js, Express, Fastify, tRPC</li>',
            '<li class="slot-skill_line"><strong>Cloud:</strong> AWS, GCP, Cloudflare, Vercel</li>',
            '<li class="slot-skill_line"><strong>Data:</strong> PostgreSQL, Redis, Kafka, ClickHouse</li>'
        ];
        // Apply skill_line slot style to each list item.
        const styled = skillLines.map(line => line.replace('<li ', `<li${styleAttr(skillStyle)} `));
        // bullet slot also styles the list shape via CSS; mirror with
        // a list-level class so the padding-left / char reaches the
        // browser.
        const listStyle = bulletStyle ? ` style="${bulletStyle}"` : '';
        pushSection('skills',
            `<ul class="slot-bullet"${listStyle}>${styled.join('')}</ul>`
        );
    }
    if (ordered.includes('experience')) {
        const jobs = [
            {
                title: 'Staff Engineer | Acme Corp | Remote | 2022 - Present',
                bullets: [
                    'Led the migration of three microservices from REST to gRPC, cutting p99 latency from 320ms to 95ms across the checkout path.',
                    'Owned the deployment pipeline for the analytics service; replaced bespoke shell scripts with a typed Go tool that the rest of the org now uses.',
                    'Wrote the canonical RFC for adopting protobuf in shared libraries and reviewed every consumer migration through rollout.'
                ]
            },
            {
                title: 'Senior Engineer | BetaSoft | Hybrid | 2019 - 2022',
                bullets: [
                    'Built the internal feature-flag service that now controls 200+ toggles; integrated with the React app, the workers, and the migration tooling.',
                    'Migrated the auth provider from a third-party SaaS to an in-house JWT setup; reduced monthly cost by roughly $8k and made the rotation policy auditable.'
                ]
            },
            {
                title: 'Software Engineer | Gamma Industries | On-site | 2017 - 2019',
                bullets: [
                    'Owned the customer-facing search experience through two redesigns and the migration from Elasticsearch 5 to 7.',
                    'Shipped the first version of the support-agent console that replaced the legacy admin panel.'
                ]
            }
        ];
        const jobsHtml = jobs.map(j => {
            const tHtml = `<p class="slot-position_line"${styleAttr(positionStyle)}><strong${styleAttr(positionStyle)}>${j.title}</strong></p>`;
            const listStyle = bulletStyle ? ` style="${bulletStyle}"` : '';
            const items = j.bullets.map(b => `<li class="slot-bullet"${styleAttr(bulletStyle)}>${b}</li>`).join('');
            return tHtml + `<ul class="slot-bullet"${listStyle}>${items}</ul>`;
        }).join('');
        pushSection('experience', jobsHtml);
    }
    if (ordered.includes('education')) {
        pushSection('education',
            `<p class="slot-education_line"${styleAttr(educationStyle || bodyStyle)}><strong${styleAttr(educationStyle)}>BS Computer Science | State University | 2013 - 2017</strong></p>`
        );
    }

    // Any unknown / custom sections from the spec, with a generic body
    // so admins see the heading style still works for non-canonical labels.
    for (const key of ordered) {
        if (CANONICAL.includes(key)) continue;
        pushSection(key,
            `<p class="slot-body_text"${styleAttr(bodyStyle)}>Section content placeholder.</p>`
        );
    }

    // Return just the body — the parent route supplies the surrounding
    // `<html><head><style>` so we can splice its own page-level CSS in.
    // Inline styles on every element cover the case where the parent
    // stylesheet is rejected, so the preview is always presentable.
    return out.join('\n');
}

module.exports = {
    buildDocx,
    buildPreviewDocx,
    buildPdfCss,
    buildMockResumeHtml,
    decorateResumeHtmlForPreview,
    looksLikeEducationLine,
    protectHyphenCompounds,
    textRunsWithNoBreakHyphens,
    collapseBrokenHyphens,
    // Exposed for unit testing
    _reorderBySpec: reorderBySpec,
    _tokeniseHtml: tokeniseHtml,
    _looksLikeSkillLineText: looksLikeSkillLineText
};

/**
 * Add slot-* classes + wrap the name/contact header so HTML preview and
 * PDF CSS match DOCX slot styling. Safe to run more than once.
 */
function decorateResumeHtmlForPreview(html) {
    if (!html || typeof html !== 'string') return html || '';
    let out = html;

    out = out.replace(/<\/?header\b[^>]*>/gi, '');
    out = out.replace(/\sclass="slot-[a-z_]+"/gi, '');

    let section = null;
    const chunks = [];
    const re = /(<h1\b[^>]*>[\s\S]*?<\/h1>)|(<h2\b[^>]*>[\s\S]*?<\/h2>)|(<ul\b[^>]*>[\s\S]*?<\/ul>)|(<p\b[^>]*>[\s\S]*?<\/p>)/gi;
    let last = 0;
    let m;
    while ((m = re.exec(out)) !== null) {
        if (m.index > last) chunks.push({ type: 'raw', html: out.slice(last, m.index) });
        const tag = m[0];
        if (m[1]) chunks.push({ type: 'h1', html: tag });
        else if (m[2]) chunks.push({ type: 'h2', html: tag });
        else if (m[3]) chunks.push({ type: 'ul', html: tag });
        else chunks.push({ type: 'p', html: tag });
        last = m.index + tag.length;
    }
    if (last < out.length) chunks.push({ type: 'raw', html: out.slice(last) });

    const addClass = (tagHtml, cls) => {
        if (/\bclass="/i.test(tagHtml)) {
            return tagHtml.replace(/\bclass="/i, `class="${cls} `);
        }
        return tagHtml.replace(/^<([a-z0-9]+)/i, `<$1 class="${cls}"`);
    };

    const plain = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const rebuilt = [];
    let i = 0;
    while (i < chunks.length) {
        const c = chunks[i];
        if (c.type === 'h1') {
            rebuilt.push('<header class="resume-head">');
            rebuilt.push(addClass(c.html, 'slot-name'));
            i += 1;
            while (i < chunks.length && chunks[i].type === 'p') {
                const t = plain(chunks[i].html);
                const isContact = /@|https?:\/\/|linkedin\.com|github\.com|\d{3}[-.\s]?\d{3}/i.test(t)
                    && !/<strong[\s>]/i.test(chunks[i].html);
                if (!isContact) break;
                rebuilt.push(addClass(chunks[i].html, 'slot-contact'));
                i += 1;
            }
            rebuilt.push('</header>');
            continue;
        }
        if (c.type === 'h2') {
            const label = plain(c.html).toLowerCase();
            if (/education|academic|qualifications/.test(label)) section = 'education';
            else if (/experience|employment|work history/.test(label)) section = 'experience';
            else if (/skill/.test(label)) section = 'skills';
            else if (/summary|profile|objective/.test(label)) section = 'summary';
            else section = null;
            rebuilt.push(addClass(c.html, 'slot-section_heading'));
            i += 1;
            continue;
        }
        if (c.type === 'ul') {
            let ul = addClass(c.html, 'slot-bullet');
            if (section === 'skills') {
                ul = ul.replace(/<li\b(?![^>]*slot-skill)/gi, '<li class="slot-skill_line"');
            }
            rebuilt.push(ul);
            i += 1;
            continue;
        }
        if (c.type === 'p') {
            const t = plain(c.html);
            const hasStrong = /<strong[\s>]/i.test(c.html);
            let cls = 'slot-body_text';
            let htmlOut = c.html;
            if (section === 'summary') cls = 'slot-summary_text';
            else if (section === 'skills') {
                cls = 'slot-skill_line';
                // Force every skill token into <strong> for preview bolding
                const inner = String(c.html).replace(/^<p\b[^>]*>/i, '').replace(/<\/p>\s*$/i, '');
                const normalized = normalizeSkillLineHtml(inner);
                if (normalized && /:\s*/.test(stripTags(normalized))) {
                    htmlOut = `<p>${normalized}</p>`;
                }
            }
            else if (section === 'education' && /edu-meta/i.test(c.html)) cls = 'slot-education_meta edu-meta';
            else if (section === 'education' && hasStrong) cls = 'slot-education_line';
            else if (section === 'experience' && hasStrong && /\|/.test(t)) cls = 'slot-position_line';
            else if (looksLikeEducationLine(t) && /\b(19|20)\d{2}\b/.test(t)) cls = 'slot-education_line';
            else if (hasStrong && /\|/.test(t) && /\b(19|20)\d{2}\b/.test(t)) cls = 'slot-position_line';
            rebuilt.push(addClass(htmlOut, cls));
            i += 1;
            continue;
        }
        rebuilt.push(c.html);
        i += 1;
    }
    return rebuilt.join('');
}