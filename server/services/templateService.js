// =============================================================================
// Resume template service
// =============================================================================
// Handles CRUD + activation for `resume_templates`, plus lazy creation of
// the built-in "Default" template on first boot. The default template's
// `style_spec` mirrors what the legacy hard-coded HTML/CSS in
// resumeService.js produced so existing resumes look identical.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { getOne, runQuery, getAll } = require('../config/database');
const { parseTemplateDocx } = require('./templateParser');
const templateExtractor = require('./templateExtractor');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// The spec for the built-in default. Captured so that resume generation
// keeps working even before any admin-uploaded template exists, and so the
// "Default" entry in the picker is always present.
const DEFAULT_STYLE_SPEC = {
    source: { file: 'builtin:default', parsed_at: null },
    fonts: {
        heading: 'Arial',
        body: 'Arial',
        default: 'Arial'
    },
    heading: {
        1: { rank: 1, font: 'Arial', size_half_pt: 32, bold: true,  align: 'center', color: null, space_before_pt: 0, space_after_pt: 5,  border_bottom: null },
        2: { rank: 2, font: 'Arial', size_half_pt: 28, bold: true,  align: 'left',   color: null, space_before_pt: 10, space_after_pt: 3, border_bottom: { style: 'single', size_pt: 0.75, color: '000000', space_pt: 1 } },
        3: { rank: 3, font: 'Arial', size_half_pt: 22, bold: true,  align: 'left',   color: null, space_before_pt: 6,  space_after_pt: 2, border_bottom: null }
    },
    body: {
        font: 'Arial',
        size_half_pt: 20,
        align: 'left',
        line_spacing: 1.35,
        space_after_pt: 2
    },
    name:     { font: 'Arial', size: 16, bold: true,  align: 'center' },
    contact:  { font: 'Arial', size: 10, bold: false, align: 'center' },
    list:     { bullet_char: '•' },
    section_order: ['summary', 'skills', 'experience', 'education']
};

// Web-safe font whitelist. Anything outside this list is rejected with a
// helpful message; users cannot upload font files (out of scope for this
// iteration per scope decision).
// Whitelist of fonts we know render correctly in headless Chromium (for
// PDF) and ship as standard DOCX fonts (so DOCX output doesn't require
// the font to be embedded). Adding fonts here means users can upload
// templates that use them without silent substitution to Arial.
//
// If you need a font outside this list, the user will get a clear
// message in the template row's "Parser notes" instead of silently
// seeing Arial — see `sanitizeSpecFonts` below.
const ALLOWED_FONTS = new Set([
    // Core web-safe + Office defaults
    'Arial',
    'Arial Narrow',
    'Helvetica',
    'Helvetica Neue',
    'Times New Roman',
    'Times',
    'Georgia',
    'Courier New',
    'Courier',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Lucida Sans Unicode',
    'Lucida Grande',
    'Segoe UI',
    'Calibri',
    'Calibri Light',
    'Cambria',
    'Candara',
    'Consolas',
    'Constantia',
    'Corbel',
    'Garamond',
    'Book Antiqua',
    'Palatino',
    'Palatino Linotype',
    'Century Gothic',
    'Franklin Gothic Medium',
    'Gill Sans',
    'Gill Sans MT',
    'Futura',
    'Optima',
    'Baskerville',
    'Didot',
    'Avenir',
    'Avenir Next',
    // Common modern resume fonts (Google Fonts / system installs).
    // Chromium / Word fall back gracefully when a face is missing.
    'Roboto',
    'Roboto Condensed',
    'Rubik',
    'Lato',
    'Montserrat',
    'Open Sans',
    'Poppins',
    'Inter',
    'Source Sans Pro',
    'Source Sans 3',
    'Source Serif Pro',
    'Source Serif 4',
    'Nunito',
    'Nunito Sans',
    'Work Sans',
    'Raleway',
    'PT Sans',
    'PT Serif',
    'Merriweather',
    'Playfair Display',
    'Lora',
    'Libre Baskerville',
    'EB Garamond',
    'Crimson Text',
    'Spectral',
    'Noto Sans',
    'Noto Serif',
    'IBM Plex Sans',
    'IBM Plex Serif',
    'Fira Sans',
    'Ubuntu',
    'Karla',
    'Mulish',
    'Manrope',
    'Outfit',
    'DM Sans',
    'Barlow',
    'Overpass',
    'Quicksand',
    'Josefin Sans',
    'Titillium Web',
    'Oswald',
    'Space Grotesk',
    'Exo 2'
]);

function normaliseFontName(name) {
    if (!name) return null;
    // Match case-insensitively against the whitelist; return the canonical
    // capitalisation so the spec stays consistent across uploads.
    const target = String(name).trim();
    for (const f of ALLOWED_FONTS) {
        if (f.toLowerCase() === target.toLowerCase()) return f;
    }
    return null;
}

// Ensure the templates directory exists and that the built-in default
// template row is seeded. Idempotent.
function ensureDefaultTemplate() {
    if (!fs.existsSync(TEMPLATES_DIR)) {
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    }
    const existing = getOne('SELECT id FROM resume_templates WHERE is_default = 1 LIMIT 1');
    if (existing) return existing;
    const result = runQuery(
        `INSERT INTO resume_templates
            (name, description, filename, file_size, style_spec, is_default, uploaded_by)
         VALUES (?, ?, ?, ?, ?, 1, NULL)`,
        [
            'Default',
            'Built-in default template (Arial, classic heading bar under each section).',
            'default',
            0,
            JSON.stringify(DEFAULT_STYLE_SPEC)
        ]
    );
    return { id: result.lastInsertRowid };
}

function listTemplates() {
    ensureDefaultTemplate();
    const rows = getAll(
        `SELECT id, name, description, filename, file_size, style_spec,
                extracted_data, candidate_profile_id,
                is_default, created_at, updated_at, uploaded_by
         FROM resume_templates
         ORDER BY is_default DESC, created_at ASC`
    );
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        filename: r.filename,
        file_size: r.file_size,
        is_default: !!r.is_default,
        created_at: r.created_at,
        updated_at: r.updated_at,
        uploaded_by: r.uploaded_by,
        candidate_profile_id: r.candidate_profile_id || null,
        // Inline the parsed spec for clients; small enough that this is
        // cheaper than a second round-trip per template.
        style_spec: safeParse(r.style_spec),
        // Surface the extracted candidate data so the admin UI can show
        // what was detected without an extra round-trip per template.
        extracted_data: safeParse(r.extracted_data)
    }));
}

function safeParse(json) {
    try { return JSON.parse(json); } catch (_) { return null; }
}

function getTemplate(id) {
    const r = getOne(
        `SELECT * FROM resume_templates WHERE id = ?`,
        [parseInt(id, 10)]
    );
    if (!r) return null;
    return {
        ...r,
        is_default: !!r.is_default,
        style_spec: safeParse(r.style_spec),
        extracted_data: safeParse(r.extracted_data)
    };
}

// Re-run the layout/style parser against the on-disk file and persist
// only the updated `style_spec`. **We deliberately do not extract
// candidate content here** — templates describe layout/style, not
// content, and persisting content auto-extracted from a template is
// misleading for admins who later want to apply it as a candidate
// profile (the existing `Apply as Profile` button is the dedicated
// route for that, and uses `extracted_data` populated by `extractTemplateCandidate`).
// Useful when an admin clicks "Re-extract" — picks up parser
// improvements, font-whitelist changes, or just refreshes after a
// manual file replacement.
async function reExtractTemplate(id) {
    ensureDefaultTemplate();
    const tpl = getTemplate(id);
    if (!tpl) throw new Error('Template not found');
    if (tpl.is_default) throw new Error('Cannot re-extract the built-in default template');

    const fp = path.join(TEMPLATES_DIR, tpl.filename);
    if (!fs.existsSync(fp)) throw new Error('Template file is missing on disk');
    const buffer = fs.readFileSync(fp);

    // 1. Re-parse the layout. Use the fresh font whitelist so older
    //    uploads whose font was previously substituted to Arial pick up
    //    the correct value (e.g. Rubik) on re-parse.
    let cleaned = null;
    let substitutions = [];
    try {
        const rawSpec = parseTemplateDocx(buffer);
        rawSpec.source.file = tpl.filename;
        rawSpec.source.parsed_at = new Date().toISOString();
        const result = sanitizeSpecFonts(rawSpec);
        cleaned = result.spec;
        substitutions = result.substitutions;
    } catch (parseErr) {
        console.warn('Re-parse failed:', parseErr.message);
    }

    // 2. Surface font substitutions as parser notes on the (otherwise-null)
    //    extracted_data blob. When an admin later clicks "Apply as Profile",
    //    we still want them to see substitution warnings.
    let extracted = null;
    if (substitutions.length) {
        extracted = {};
        extracted.notes = substitutions.map(s =>
            `Font "${s.from}" in ${s.where} is not on the render whitelist and was replaced with "${s.to}".`
        );
    }

    runQuery(
        `UPDATE resume_templates
         SET style_spec = ?, extracted_data = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            cleaned ? JSON.stringify(cleaned) : (tpl.style_spec ? JSON.stringify(tpl.style_spec) : null),
            extracted ? JSON.stringify(extracted) : (tpl.extracted_data ? JSON.stringify(tpl.extracted_data) : null),
            parseInt(id, 10)
        ]
    );
    return getTemplate(id);
}

// Explicit content extraction — separate from template upload/re-extract
// because templates are layout/style; only an admin who clicks
// "Apply as Profile" actually wants the candidate data extracted. Returns
// the extracted_data blob to be persisted on the template row.
async function extractTemplateCandidate(id) {
    ensureDefaultTemplate();
    const tpl = getTemplate(id);
    if (!tpl) throw new Error('Template not found');
    if (tpl.is_default) throw new Error('Cannot extract a candidate profile from the built-in default template');

    const fp = path.join(TEMPLATES_DIR, tpl.filename);
    if (!fs.existsSync(fp)) throw new Error('Template file is missing on disk');
    const buffer = fs.readFileSync(fp);

    let extracted = null;
    try {
        const ex = await templateExtractor.extractCandidateFromDocx(buffer);
        // Drop the heavy raw_text blob before persisting.
        const { raw_text, ...persisted } = ex || {};
        extracted = persisted;
    } catch (extractErr) {
        console.warn('Resume content extraction failed:', extractErr.message);
        throw new Error('Could not parse candidate content from this template: ' + extractErr.message);
    }

    runQuery(
        `UPDATE resume_templates
         SET extracted_data = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            extracted ? JSON.stringify(extracted) : null,
            parseInt(id, 10)
        ]
    );
    return getTemplate(id);
}

// Build the value objects we need to insert/update a candidate_profiles
// row from an `extracted_data` blob. Returns the column map with whatever
// fields the extractor actually populated — nulls for the rest.
function profileColumnsFromExtracted(extracted) {
    if (!extracted) return null;
    const { name = {}, contact = {}, location = {}, summary, skills = [], work_experience = [], education = [] } = extracted;
    return {
        first_name:  name.first  || null,
        middle_name: name.middle || null,
        last_name:   name.last   || null,
        email:       contact.email || null,
        phone:       contact.phone || null,
        linkedin_url: contact.linkedin_url || null,
        github_url:   contact.github_url || null,
        city:  location.city  || null,
        state: location.state || null,
        country: location.country || null,
        // store the structured arrays as JSON so the existing profile
        // pages can read them back unchanged.
        work_experience: work_experience.length ? JSON.stringify(work_experience) : null,
        education:       education.length       ? JSON.stringify(education)       : null,
        resume_prompt:   summary || null
    };
}

// Upload a new template: parses the buffer, stores the file under
// templates/, persists ONLY the parsed layout/style spec. Candidate
// content extraction is intentionally NOT triggered here — templates
// are layout/style, not candidate data. To create a candidate profile
// from a template, an admin clicks "Apply as Profile" which calls the
// dedicated `extractTemplateCandidate` + apply route.
async function uploadTemplate({ name, description, filename, buffer, uploadedBy }) {
    if (!name || !name.trim()) {
        throw new Error('Template name is required');
    }
    if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Template file buffer is required');
    }
    if (!filename) {
        throw new Error('Template filename is required');
    }

    // Parse BEFORE we commit anything to disk so we fail fast on garbage.
    const spec = parseTemplateDocx(buffer);
    spec.source.file = filename;
    spec.source.parsed_at = new Date().toISOString();

    // Whitelist-check any fonts the template references — unknown fonts
    // get replaced with Arial and the substitution is recorded so the
    // admin sees what happened instead of silently getting Arial.
    const { spec: cleaned, substitutions } = sanitizeSpecFonts(spec);

    // Surface font substitutions as parser notes on the (otherwise-null)
    // extracted_data blob. This is meta-info, not candidate content — the
    // admin sees it via the ExtractedData panel without us having
    // auto-extracted anything.
    let extracted = null;
    if (substitutions.length) {
        extracted = {};
        extracted.notes = substitutions.map(s =>
            `Font "${s.from}" in ${s.where} is not on the render whitelist and was replaced with "${s.to}".`
        );
    }

    // Persist file to disk
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fullPath = path.join(TEMPLATES_DIR, safeFilename);
    fs.writeFileSync(fullPath, buffer);

    const result = runQuery(
        `INSERT INTO resume_templates
            (name, description, filename, file_size, style_spec, extracted_data, is_default, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [
            name.trim(),
            (description || '').trim(),
            safeFilename,
            buffer.length,
            JSON.stringify(cleaned),
            extracted ? JSON.stringify(extracted) : null,
            uploadedBy || null
        ]
    );

    return getTemplate(result.lastInsertRowid);
}

// Recursively walk the spec and replace any font that isn't on the
// whitelist with "Arial". Returns { spec, substitutions } so callers can
// surface the swap to the admin instead of silently dropping the font.
function sanitizeSpecFonts(spec) {
    const substitutions = [];
    if (!spec) return { spec, substitutions };

    const out = JSON.parse(JSON.stringify(spec));

    // Helper that records a substitution and replaces the field with
    // the safe value (or Arial when the font is unknown).
    const swap = (where, current, original) => {
        if (!current || typeof current !== 'string') return current || 'Arial';
        const safe = normaliseFontName(current);
        if (safe && safe === current) return safe;
        const fallback = safe || 'Arial';
        if (original && original !== fallback) {
            substitutions.push({ where, from: original, to: fallback });
        }
        return fallback;
    };

    if (out.fonts) {
        for (const k of Object.keys(out.fonts)) {
            out.fonts[k] = swap(`fonts.${k}`, out.fonts[k], out.fonts[k]);
        }
    }
    if (out.heading) {
        for (const k of Object.keys(out.heading)) {
            out.heading[k].font = swap(`heading.${k}.font`, out.heading[k].font, out.heading[k].font);
        }
    }
    if (out.body) {
        out.body.font = swap('body.font', out.body.font, out.body.font);
        if (Array.isArray(out.body.font_pool)) {
            out.body.font_pool = [...new Set(
                out.body.font_pool
                    .map((f) => swap('body.font_pool', f, f))
                    .filter(Boolean)
            )];
            if (!out.body.font_pool.length) {
                out.body.font_pool = [out.body.font || 'Arial'];
            } else if (out.body.font && !out.body.font_pool.includes(out.body.font)) {
                out.body.font_pool = [out.body.font, ...out.body.font_pool];
            }
        }
    }
    if (out.name) {
        out.name.font = swap('name.font', out.name.font, out.name.font);
    }
    if (out.contact) {
        out.contact.font = swap('contact.font', out.contact.font, out.contact.font);
    }
    return { spec: out, substitutions };
}

function deleteTemplate(id) {
    const r = getOne('SELECT * FROM resume_templates WHERE id = ?', [parseInt(id, 10)]);
    if (!r) return false;
    if (r.is_default) {
        throw new Error('Cannot delete the built-in default template');
    }
    // Remove the file from disk (best-effort — missing files are fine)
    try {
        const fullPath = path.join(TEMPLATES_DIR, r.filename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch (_) { /* swallow */ }
    runQuery('DELETE FROM resume_templates WHERE id = ?', [parseInt(id, 10)]);
    return true;
}

function templateFilePath(id) {
    const r = getOne('SELECT filename, is_default FROM resume_templates WHERE id = ?', [parseInt(id, 10)]);
    if (!r) return null;
    if (r.is_default) return null;   // no on-disk file for the builtin
    const fullPath = path.join(TEMPLATES_DIR, r.filename);
    return fs.existsSync(fullPath) ? fullPath : null;
}

// Convenience: resolve the effective style spec for an application.
// Falls back to the default template if the requested one is missing.
function resolveStyleSpec({ templateId }) {
    ensureDefaultTemplate();
    let tpl = null;
    if (templateId != null) {
        tpl = getTemplate(templateId);
    }
    if (!tpl) {
        tpl = getOne('SELECT * FROM resume_templates WHERE is_default = 1 LIMIT 1');
        tpl = tpl ? { ...tpl, style_spec: safeParse(tpl.style_spec) } : { style_spec: DEFAULT_STYLE_SPEC };
    }
    return tpl.style_spec || DEFAULT_STYLE_SPEC;
}

module.exports = {
    TEMPLATES_DIR,
    ALLOWED_FONTS,
    DEFAULT_STYLE_SPEC,
    ensureDefaultTemplate,
    listTemplates,
    getTemplate,
    uploadTemplate,
    deleteTemplate,
    templateFilePath,
    normaliseFontName,
    resolveStyleSpec,
    reExtractTemplate,
    extractTemplateCandidate,
    profileColumnsFromExtracted
};