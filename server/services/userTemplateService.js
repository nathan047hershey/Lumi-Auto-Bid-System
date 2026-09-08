// =============================================================================
// User-authored resume template service
// =============================================================================
// CRUD over the `user_resume_templates` table. Each row stores a JSON
// `style_spec` describing:
//   - the section block order (summary, skills, experience, education)
//   - the contact-info field order (address, phone, email, linkedin, github)
//   - per-element font sizes + alignments
//   - the experience-row layout (1-col stacked vs 2-col title|dates)
//   - which sections are visible / included
//
// The renderer (templateRenderer.buildDocx) already accepts an arbitrary
// style_spec JSON, so user templates plug into the existing DOCX +
// PDF generation without any new render path. We just need to feed
// well-formed specs into resumeService.generateResume.
//
// Spec shape (consumed by the renderer; also rendered into the builder UI):
//
//   {
//     "schema_version": 1,
//     "fonts": { "heading": "Arial", "body": "Arial", "default": "Arial" },
//     "name":    { "font": "Arial", "size_half_pt": 32, "bold": true,  "align": "center" },
//     "contact": { "font": "Arial", "size_half_pt": 20, "bold": false, "align": "center" },
//     "blocks": [
//       { "id": "summary",   "label": "Summary",   "visible": true },
//       { "id": "skills",    "label": "Core Skills", "visible": true },
//       { "id": "experience","label": "Work Experience", "visible": true },
//       { "id": "education", "label": "Education", "visible": true }
//     ],
//     "contact_fields": [
//       { "id": "city_state", "label": "City, State", "source": "city_state", "visible": true },
//       { "id": "email",      "label": "Email",        "source": "email",      "visible": true },
//       { "id": "phone",      "label": "Phone",        "source": "phone",      "visible": true },
//       { "id": "linkedin",   "label": "LinkedIn URL", "source": "linkedin_url","visible": true },
//       { "id": "github",     "label": "GitHub URL",   "source": "github_url",  "visible": true }
//     ],
//     "experience_row": {
//       "layout": "two_column",      // 'stacked' | 'two_column'
//       "title_align": "left",        // alignment of the title line
//       "dates_align": "right",       // alignment of the dates segment
//       "show_company": true,
//       "show_location": true
//     },
//     "heading": {
//       "1": { "size_half_pt": 32, "bold": true,  "align": "center" },
//       "2": { "size_half_pt": 28, "bold": true,  "align": "left", "border_bottom": { "style":"single", "size_pt": 0.75, "color":"000000", "space_pt": 1 } },
//       "3": { "size_half_pt": 22, "bold": true,  "align": "left" }
//     },
//     "body": { "size_half_pt": 20, "align": "left", "line_spacing": 1.35 },
//     "section_order": ["summary", "skills", "experience", "education"]
//   }
// =============================================================================

const { getOne, getAll, runQuery } = require('../config/database');

// Whitelisted font names — must match the renderer whitelist so a
// template built with an allowed font renders the same in DOCX + PDF.
// Reuse templateService's set so admin uploads and the user builder
// never drift apart.
const templateService = require('./templateService');
const ALLOWED_FONTS = templateService.ALLOWED_FONTS;

// The default template every new user starts with. Mirrors the
// built-in default in templateService.js so existing resumes look
// identical when a user picks this template.
function defaultStyleSpec() {
    return {
        schema_version: 1,
        fonts: { heading: 'Arial', body: 'Arial', default: 'Arial' },
        name:    { font: 'Arial', size_half_pt: 32, bold: true,  underline: false, italic: false, uppercase: false, color: null, align: 'center' },
        contact: { font: 'Arial', size_half_pt: 20, bold: false, underline: false, italic: false, color: null, align: 'center' },
        blocks: [
            { id: 'summary',    label: 'Summary',         visible: true },
            { id: 'skills',     label: 'Core Skills',     visible: true },
            { id: 'experience', label: 'Work Experience', visible: true },
            { id: 'education',  label: 'Education',       visible: true }
        ],
        contact_fields: [
            { id: 'city_state', label: 'City, State', source: 'city_state',  visible: true },
            { id: 'email',      label: 'Email',        source: 'email',       visible: true },
            { id: 'phone',      label: 'Phone',        source: 'phone',       visible: true },
            { id: 'linkedin',   label: 'LinkedIn URL', source: 'linkedin_url',visible: true },
            { id: 'github',     label: 'GitHub URL',   source: 'github_url',  visible: true }
        ],
        // Character placed between contact-line items (city, email,
        // phone, linkedin, github). Defaults to '|' to match legacy
        // behaviour. Allowed: '|' (pipe), '•' (bullet), ',' (comma),
        // '-' (dash), '·' (middle dot). Whitelisted in sanitizeSpec
        // so the renderer can use it directly without escaping.
        contact_separator: '|',
        experience_row: {
            layout: 'two_column',
            // The character used between segments when all 4 fit on a
            // single line. Values: '|' (default), '•', ','. The render
            // splits the AI's pipe-separated title row on ' | ' first,
            // then re-joins segments with this character.
            separator: '|',
            // Per-segment alignment. Only `title_align` and `dates_align`
            // were honored before; the renderer now reads all four so a
            // template can e.g. right-align the location segment.
            title_align: 'left',
            company_align: 'left',
            location_align: 'left',
            dates_align: 'right',
            // Per-segment italic toggle. The job title stays bold by
            // default; italic lets users soften the company/location
            // segments so the title visually pops.
            title_italic: false,
            company_italic: true,
            location_italic: true,
            dates_italic: false,
            // When true, that segment starts on a NEW LINE rather than
            // sitting inline with the previous one. Common use: split
            // company onto its own line under the title so the title
            // pops. Both wraps are independent.
            wrap_title_company: false,
            wrap_company_location: false,
            show_company: true,
            show_location: true,
            // When true, the AI emits a single italicized one-sentence
            // "work summary" line per job (rendered above the bullet
            // list, NOT as a bullet). Renderer honors the flag.
            work_summary: false,
            // Extra space (pt) before each job title block.
            job_gap_pt: 6
        },
        heading: {
            1: { font: 'Arial', size_half_pt: 32, bold: true, align: 'center', color: null, uppercase: false, italic: false },
            2: { font: 'Arial', size_half_pt: 28, bold: true, align: 'left', color: null, uppercase: false, italic: false,
                 border_bottom: { style: 'single', size_pt: 0.75, color: '000000', space_pt: 1 },
                 space_before_pt: 10, space_after_pt: 3 },
            3: { font: 'Arial', size_half_pt: 22, bold: true, align: 'left', color: null, uppercase: false, italic: false,
                 space_before_pt: 6, space_after_pt: 2 }
        },
        body: {
            font: 'Arial',
            // Optional pool of body fonts. When generating a resume with
            // no explicit font_family, one entry is chosen at random.
            font_pool: ['Arial'],
            size_half_pt: 20,
            align: 'left',
            line_spacing: 1.35,
            space_after_pt: 2,
            color: null
        },
        // Page margins in points (36pt = 0.5"). Honored by the DOCX
        // renderer and the live preview so denser / airier layouts are
        // possible without re-uploading a DOCX.
        page: {
            paper_size: 'letter',
            margin_top_pt: 36,
            margin_bottom_pt: 36,
            margin_left_pt: 36,
            margin_right_pt: 36
        },
        // Shared accent used by the builder's "Theme color" control —
        // applied to name + section headings + underline bars.
        theme: {
            accent_color: null
        },
        // Bullet list fingerprint used for experience / education /
        // skills list items.
        list: {
            bullet_char: '•',
            indent_left_pt: 18,
            indent_hanging_pt: 18,
            space_after_pt: 2
        },
        section_order: ['summary', 'skills', 'experience', 'education']
    };
}

function safeParse(json) {
    if (!json) return null;
    try { return JSON.parse(json); } catch (_) { return null; }
}

// Sanitize a font name against the whitelist. Unknown / null fonts
// fall back to 'Arial'. Used when persisting a user-built template so
// a typo in the UI can't crash the renderer later. Match is
// case-insensitive so "calibri" / "Calibri" both survive.
function safeFont(name) {
    if (!name || typeof name !== 'string') return 'Arial';
    const target = name.trim();
    for (const f of ALLOWED_FONTS) {
        if (f.toLowerCase() === target.toLowerCase()) return f;
    }
    return 'Arial';
}

// Accept RRGGBB / #RRGGBB; return uppercase RRGGBB or null.
function safeColor(value) {
    if (!value || typeof value !== 'string') return null;
    const m = value.trim().replace(/^#/, '').match(/^[0-9A-Fa-f]{6}$/);
    return m ? m[0].toUpperCase() : null;
}

// Sanitize the whole spec. Anything missing falls back to a default;
// unknown fonts become Arial; unknown blocks get dropped.
function sanitizeSpec(input) {
    const base = defaultStyleSpec();
    const spec = input && typeof input === 'object' ? input : {};
    const out = JSON.parse(JSON.stringify(base));

    if (spec.name && typeof spec.name === 'object') {
        out.name = {
            font: safeFont(spec.name.font),
            size_half_pt: Number(spec.name.size_half_pt) || base.name.size_half_pt,
            bold: spec.name.bold !== false,
            underline: spec.name.underline === true,
            italic: spec.name.italic === true,
            uppercase: spec.name.uppercase === true,
            color: safeColor(spec.name.color),
            align: ['left','center','right','justify'].includes(spec.name.align) ? spec.name.align : base.name.align
        };
    }
    if (spec.contact && typeof spec.contact === 'object') {
        out.contact = {
            font: safeFont(spec.contact.font),
            size_half_pt: Number(spec.contact.size_half_pt) || base.contact.size_half_pt,
            bold: spec.contact.bold === true,
            underline: spec.contact.underline === true,
            italic: spec.contact.italic === true,
            color: safeColor(spec.contact.color),
            align: ['left','center','right','justify'].includes(spec.contact.align) ? spec.contact.align : base.contact.align
        };
    }
    if (Array.isArray(spec.blocks)) {
        const allowed = new Set(['summary','skills','experience','education']);
        const seen = new Set();
        out.blocks = spec.blocks
            .filter(b => b && allowed.has(b.id) && !seen.has(b.id))
            .map(b => ({
                id: b.id,
                label: String(b.label || b.id).slice(0, 60),
                visible: b.visible !== false
            }))
            .concat(
                // Append any allowed defaults that the spec omitted, in
                // their default order, so the builder never produces a
                // partial block list.
                ['summary','skills','experience','education']
                    .filter(id => !out.blocks.some(b => b.id === id))
                    .map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), visible: true }))
            );
    }
    if (Array.isArray(spec.contact_fields)) {
        const allowedSrc = new Set(['city_state','email','phone','linkedin_url','github_url']);
        const seen = new Set();
        out.contact_fields = spec.contact_fields
            .filter(f => f && allowedSrc.has(f.source) && !seen.has(f.source))
            .map(f => ({
                id: f.id || f.source,
                label: String(f.label || f.source).slice(0, 60),
                source: f.source,
                visible: f.visible !== false
            }));
    }
    if (spec.experience_row && typeof spec.experience_row === 'object') {
        const er = spec.experience_row;
        // Allowed separators. The renderer relies on this whitelist so
        // a typo in the builder UI can't inject a literal < or > into
        // the rendered DOCX.
        const SEP_WHITELIST = ['|', '•', ',', '-', '·'];
        const sep = SEP_WHITELIST.includes(er.separator) ? er.separator : '|';
        const alignOk = (v) => ['left','center','right'].includes(v) ? v : null;
        out.experience_row = {
            layout: er.layout === 'stacked' ? 'stacked' : 'two_column',
            separator: sep,
            title_align:    alignOk(er.title_align)    || 'left',
            company_align:  alignOk(er.company_align)  || 'left',
            location_align: alignOk(er.location_align) || 'left',
            dates_align:    alignOk(er.dates_align)    || 'right',
            title_italic:    er.title_italic === true,
            company_italic:  er.company_italic === true,
            location_italic: er.location_italic === true,
            dates_italic:    er.dates_italic === true,
            wrap_title_company:   er.wrap_title_company === true,
            wrap_company_location: er.wrap_company_location === true,
            show_company: er.show_company !== false,
            show_location: er.show_location !== false,
            work_summary: er.work_summary === true,
            job_gap_pt: (() => {
                const n = Number(er.job_gap_pt);
                if (!Number.isFinite(n)) return out.experience_row.job_gap_pt ?? 6;
                return Math.max(0, Math.min(36, n));
            })()
        };
    }
    // Keep heading[1|2|3] sane — including font (previously dropped on
    // save, which forced every reloaded template back to Arial).
    if (spec.heading && typeof spec.heading === 'object') {
        for (const k of ['1','2','3']) {
            if (spec.heading[k] && typeof spec.heading[k] === 'object') {
                const h = spec.heading[k];
                const prevBorder = out.heading[k].border_bottom;
                out.heading[k] = {
                    font: safeFont(h.font || out.heading[k].font),
                    size_half_pt: Number(h.size_half_pt) || out.heading[k].size_half_pt,
                    bold: h.bold !== false,
                    underline: h.underline === true,
                    italic: h.italic === true,
                    uppercase: h.uppercase === true,
                    color: safeColor(h.color),
                    align: ['left','center','right','justify'].includes(h.align) ? h.align : out.heading[k].align,
                    space_before_pt: Number.isFinite(Number(h.space_before_pt))
                        ? Math.max(0, Math.min(48, Number(h.space_before_pt)))
                        : (out.heading[k].space_before_pt ?? 0),
                    space_after_pt: Number.isFinite(Number(h.space_after_pt))
                        ? Math.max(0, Math.min(48, Number(h.space_after_pt)))
                        : (out.heading[k].space_after_pt ?? 0)
                };
                if (h.border_bottom && typeof h.border_bottom === 'object') {
                    out.heading[k].border_bottom = {
                        style: h.border_bottom.style || 'single',
                        size_pt: Number(h.border_bottom.size_pt) || 0.75,
                        color: (h.border_bottom.color && /^[0-9A-Fa-f]{6}$/.test(h.border_bottom.color))
                            ? h.border_bottom.color : '000000',
                        space_pt: Number(h.border_bottom.space_pt) || 1
                    };
                } else if (h.border_bottom === null) {
                    // Explicitly cleared in the builder.
                } else if (prevBorder) {
                    out.heading[k].border_bottom = prevBorder;
                }
            }
        }
    }
    if (spec.body && typeof spec.body === 'object') {
        const ls = Number(spec.body.line_spacing);
        const sa = Number(spec.body.space_after_pt);
        const rawPool = Array.isArray(spec.body.font_pool) ? spec.body.font_pool : null;
        let fontPool = rawPool
            ? [...new Set(rawPool.map((f) => safeFont(f)).filter(Boolean))]
            : null;
        const primaryFont = safeFont(spec.body.font || out.body.font);
        // Always keep at least the primary font in the pool so random
        // generation and the single-font preview stay in sync.
        if (!fontPool || fontPool.length === 0) {
            fontPool = [primaryFont];
        } else if (!fontPool.includes(primaryFont)) {
            fontPool = [primaryFont, ...fontPool];
        }
        out.body = {
            font: primaryFont,
            font_pool: fontPool,
            size_half_pt: Number(spec.body.size_half_pt) || out.body.size_half_pt,
            align: ['left','center','right','justify'].includes(spec.body.align) ? spec.body.align : out.body.align,
            line_spacing: (Number.isFinite(ls) && ls >= 1 && ls <= 3) ? ls : out.body.line_spacing,
            space_after_pt: (Number.isFinite(sa) && sa >= 0 && sa <= 24) ? sa : (out.body.space_after_pt ?? 2),
            color: safeColor(spec.body.color)
        };
    }

    // Page margins (points). Clamp to 18–108pt (~0.25"–1.5") so a
    // typo can't produce an unprintable page.
    if (spec.page && typeof spec.page === 'object') {
        const clampMargin = (v, fallback) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(18, Math.min(108, n));
        };
        out.page = {
            paper_size: spec.page.paper_size === 'a4' ? 'a4' : 'letter',
            margin_top_pt: clampMargin(spec.page.margin_top_pt, out.page?.margin_top_pt ?? 36),
            margin_bottom_pt: clampMargin(spec.page.margin_bottom_pt, out.page?.margin_bottom_pt ?? 36),
            margin_left_pt: clampMargin(spec.page.margin_left_pt, out.page?.margin_left_pt ?? 36),
            margin_right_pt: clampMargin(spec.page.margin_right_pt, out.page?.margin_right_pt ?? 36)
        };
    }

    if (spec.theme && typeof spec.theme === 'object') {
        out.theme = {
            accent_color: safeColor(spec.theme.accent_color)
        };
    }

    // Bullet list settings.
    if (spec.list && typeof spec.list === 'object') {
        const BULLET_WHITELIST = ['•', '○', '▪', '■', '–', '—', '-', '*', '◦', '‣'];
        const bullet = BULLET_WHITELIST.includes(spec.list.bullet_char)
            ? spec.list.bullet_char
            : (out.list?.bullet_char || '•');
        const clampIndent = (v, fallback) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(0, Math.min(72, n));
        };
        out.list = {
            bullet_char: bullet,
            indent_left_pt: clampIndent(spec.list.indent_left_pt, out.list?.indent_left_pt ?? 18),
            indent_hanging_pt: clampIndent(spec.list.indent_hanging_pt, out.list?.indent_hanging_pt ?? 18),
            space_after_pt: clampIndent(spec.list.space_after_pt, out.list?.space_after_pt ?? 2)
        };
    }

    // Keep the top-level fonts map in sync with the slots the builder
    // actually edits, so older render paths that read fonts.body /
    // fonts.heading still pick up the user's choice.
    out.fonts = {
        heading: safeFont(out.heading?.['2']?.font || out.name?.font || out.fonts.heading),
        body: safeFont(out.body?.font || out.fonts.body),
        default: safeFont(out.body?.font || out.fonts.default)
    };
    // Derive section_order from the visible blocks the user asked for
    // so the renderer's section_order field never drifts.
    out.section_order = out.blocks.filter(b => b.visible).map(b => b.id);

    // Contact-line separator: kept on a top-level field of the spec
    // so the builder UI can show it next to the contact-fields
    // reorder list. Allowed chars are whitelisted to keep the
    // renderer safe (no HTML / no XML injection).
    const CONTACT_SEP_WHITELIST = ['|', '•', ',', '-', '·'];
    out.contact_separator = CONTACT_SEP_WHITELIST.includes(spec.contact_separator)
        ? spec.contact_separator
        : '|';

    // Section heading text overrides: a map from canonical section
    // key (summary/skills/experience/education) to the user's
    // preferred <h2> label. The renderer in reorderBySpec replaces
    // the AI's heading text with this value BEFORE the HTML reaches
    // the DOCX builder, so a rename applied in the template
    // builder carries through to the generated DOCX. Empty /
    // whitespace / non-string values are dropped so a blank input
    // falls back to the AI's original label (matching the builder
    // UI's "leave blank to keep" affordance). Values are length-
    // capped at 60 chars so a runaway paste can't bloat the
    // heading paragraph, and HTML-significant chars are stripped so
    // a malicious paste can't inject markup into the renderer.
    if (spec.section_labels && typeof spec.section_labels === 'object') {
        const LABEL_KEY_WHITELIST = ['summary', 'skills', 'experience', 'education'];
        const labels = {};
        for (const k of LABEL_KEY_WHITELIST) {
            const v = spec.section_labels[k];
            if (typeof v !== 'string') continue;
            const cleaned = v.trim().slice(0, 60).replace(/[<>]/g, '');
            if (cleaned) labels[k] = cleaned;
        }
        if (Object.keys(labels).length) out.section_labels = labels;
    }

    return out;
}

function listForUser(userId) {
    const rows = getAll(`
        SELECT id, user_id, name, description, kind, style_spec,
               is_default, is_editable, last_used_at, created_at, updated_at
        FROM user_resume_templates
        WHERE user_id = ?
        ORDER BY is_default DESC, last_used_at DESC NULLS LAST, updated_at DESC
    `, [userId]);
    return rows.map(r => ({ ...r, style_spec: safeParse(r.style_spec) }));
}

function getForUser(userId, id) {
    const row = getOne(`
        SELECT id, user_id, name, description, kind, style_spec,
               is_default, is_editable, last_used_at, created_at, updated_at
        FROM user_resume_templates
        WHERE id = ? AND user_id = ?
    `, [parseInt(id, 10), userId]);
    if (!row) return null;
    return { ...row, style_spec: safeParse(row.style_spec) };
}

// Maximum number of auto-rename attempts when the user submits a name
// that collides with an existing row. After this many tries we throw
// a 409 Conflict so the UI can prompt for a different name rather than
// silently create "My Template (copy 999)".
const MAX_RENAME_ATTEMPTS = 50;

function createForUser(userId, { name, description, style_spec, kind, is_default, is_editable }) {
    if (!name || !name.trim()) throw new Error('Template name is required');
    const cleaned = sanitizeSpec(style_spec || defaultStyleSpec());

    // Detect a name collision on the (user_id, name) UNIQUE constraint
    // and auto-rename to "<name> (copy)", "<name> (copy 2)", etc. — the
    // same pattern macOS Finder / Google Drive use for "duplicate".
    // Without this, the builder UI's "Save" on `/user/templates/new`
    // trips a raw UNIQUE-constraint 500 every time the user accepts
    // the default "My Template" name when they already have a seeded
    // row with that exact name. Auto-renaming keeps the create path
    // idempotent for the common case; the UI surfaces the actual
    // stored name in the success toast so the user sees what happened.
    const requestedName = name.trim().slice(0, 80);
    let finalName = requestedName;
    for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
        const existing = getOne(
            'SELECT id FROM user_resume_templates WHERE user_id = ? AND name = ?',
            [userId, finalName]
        );
        if (!existing) break;
        if (attempt === 0) {
            finalName = `${requestedName} (copy)`;
        } else {
            finalName = `${requestedName} (copy ${attempt + 1})`;
        }
        // Belt + braces: if even the suffixed name collides after
        // MAX_RENAME_ATTEMPTS iterations, surface a clean 409 instead
        // of a raw sqlite UNIQUE error.
        if (attempt === MAX_RENAME_ATTEMPTS - 1) {
            throw new Error('A template with this name already exists. Please choose a different name.');
        }
    }

    const isDefault = is_default ? 1 : 0;
    // When a row is marked default, clear the previous default so each
    // user only has one. Same pattern as resume_templates.
    if (isDefault) {
        runQuery('UPDATE user_resume_templates SET is_default = 0 WHERE user_id = ?', [userId]);
    }
    const r = runQuery(
        `INSERT INTO user_resume_templates
            (user_id, name, description, kind, style_spec, is_default, is_editable)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            finalName,
            (description || '').trim().slice(0, 200),
            kind === 'clone' ? 'clone' : 'builder',
            JSON.stringify(cleaned),
            isDefault,
            is_editable === false ? 0 : 1
        ]
    );
    return getForUser(userId, r.lastInsertRowid);
}

function updateForUser(userId, id, { name, description, style_spec, is_default, is_editable }) {
    const existing = getForUser(userId, id);
    if (!existing) return null;
    if (!existing.is_editable) {
        // Templates marked non-editable (e.g. a future read-only seed)
        // cannot be mutated. Surface a friendly error rather than a
        // silent 200 so the UI can show a real message.
        throw new Error('This template is read-only');
    }
    const cleaned = style_spec ? sanitizeSpec(style_spec) : existing.style_spec;
    const nextName = (name && name.trim()) ? name.trim().slice(0, 80) : existing.name;
    const nextDesc = description != null
        ? String(description).trim().slice(0, 200)
        : existing.description;
    const nextDefault = is_default != null ? (is_default ? 1 : 0) : (existing.is_default ? 1 : 0);
    if (nextDefault) {
        runQuery('UPDATE user_resume_templates SET is_default = 0 WHERE user_id = ? AND id <> ?', [userId, id]);
    }
    runQuery(
        `UPDATE user_resume_templates
         SET name = ?, description = ?, style_spec = ?, is_default = ?, is_editable = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [
            nextName,
            nextDesc,
            JSON.stringify(cleaned),
            nextDefault,
            is_editable === false ? 0 : 1,
            parseInt(id, 10),
            userId
        ]
    );
    return getForUser(userId, id);
}

function deleteForUser(userId, id) {
    const existing = getForUser(userId, id);
    if (!existing) return false;
    runQuery('DELETE FROM user_resume_templates WHERE id = ? AND user_id = ?', [parseInt(id, 10), userId]);
    return true;
}

// Resolve a user template by id, returning just the style_spec JSON
// that resumeService.generateResume / templateRenderer can consume.
// Returns null when the id is null / missing.
function resolveStyleSpecForUser(userId, templateId) {
    if (!templateId) return null;
    const row = getForUser(userId, templateId);
    if (!row) return null;
    runQuery(
        'UPDATE user_resume_templates SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
        [parseInt(templateId, 10)]
    );
    return row.style_spec;
}

// Resolve a user template by id WITHOUT owner filtering. Used when
// an admin assigns another user's drag-drop template to a
// candidate profile — the user generating the resume is not the
// owner, so owner-scoped lookups would fail. We still bump
// last_used_at so the picker can surface "recently used" hints
// regardless of ownership.
function resolveStyleSpecAnyOwner(templateId) {
    if (!templateId) return null;
    const row = getOne(
        'SELECT id, style_spec FROM user_resume_templates WHERE id = ?',
        [parseInt(templateId, 10)]
    );
    if (!row) return null;
    runQuery(
        'UPDATE user_resume_templates SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
        [parseInt(templateId, 10)]
    );
    return safeParse(row.style_spec);
}

// Seed a user with the default builder template if they have none yet.
// Idempotent; called once when the user opens ResumeGenerator.
function ensureSeed(userId) {
    const existing = getOne('SELECT id FROM user_resume_templates WHERE user_id = ? LIMIT 1', [userId]);
    if (existing) return null;
    return createForUser(userId, {
        name: 'My Template',
        description: 'Default starter template — drag blocks to reorder.',
        style_spec: defaultStyleSpec(),
        kind: 'builder',
        is_default: true
    });
}

module.exports = {
    ALLOWED_FONTS,
    defaultStyleSpec,
    sanitizeSpec,
    listForUser,
    getForUser,
    createForUser,
    updateForUser,
    deleteForUser,
    resolveStyleSpecForUser,
    resolveStyleSpecAnyOwner,
    ensureSeed
};