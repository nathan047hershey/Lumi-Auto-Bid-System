/**
 * Resume name/contact header helpers.
 *
 * Contact layout:
 *   Line 1 — city/state | email | phone  (pipe-separated)
 *   Line 2+ — LinkedIn / GitHub each on their own line
 *
 * Email and profile URLs are real hyperlinks (mailto: / https:) in
 * HTML preview, PDF, and DOCX. Visible text stays the clean address/URL.
 */

'use strict';

const CONTACT_SEP_RE = /^[|•,\-·]$/;

function contactSeparator(styleSpec) {
    const sep = styleSpec?.contact_separator;
    return (typeof sep === 'string' && CONTACT_SEP_RE.test(sep)) ? sep : '|';
}

/** Strip link markup / schemes so we can rebuild clean display text. */
function stripContactLinks(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    s = s.replace(/<\/?[^>]+>/g, '');
    s = s.replace(/^mailto:/i, '').replace(/^tel:/i, '');
    // Drop ZWSP / soft-hyphen left over from older anti-link hacks.
    s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '');
    return s.trim();
}

/** Normalize LinkedIn / profile URLs for a clean contact line. */
function normalizeContactUrl(raw) {
    let s = stripContactLinks(raw);
    if (!s) return '';
    // Collapse accidental spaces around :// or @
    s = s.replace(/\s*:\s*\/\s*\//g, '://').replace(/\s+@\s*/g, '@').replace(/\s+/g, '');
    if (/linkedin\.com/i.test(s) || /github\.com/i.test(s) || /^www\./i.test(s)) {
        if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
        s = s.replace(/\/+$/, '');
    }
    return s;
}

/** Plain contact text for display — no ZWSP, no link markup. */
function plainContactText(raw) {
    const s = stripContactLinks(raw);
    if (!s) return '';
    if (/https?:\/\//i.test(s) || /linkedin\.com|github\.com/i.test(s) || /^www\./i.test(s)) {
        return normalizeContactUrl(s);
    }
    // Email / phone / city — strip junk only
    return s.replace(/\s+@\s*/g, '@');
}

function isEmailLike(s) {
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(s || '').trim());
}

function pushCityState(parts, profile) {
    if (profile.city && profile.state) parts.push({ kind: 'text', text: `${profile.city}, ${profile.state}` });
    else if (profile.city) parts.push({ kind: 'text', text: profile.city });
    else if (profile.state) parts.push({ kind: 'text', text: profile.state });
}

/**
 * Structured contact for HTML + DOCX.
 * primary: [{ kind: 'text'|'email', text, href? }]
 * urls:    [{ kind: 'url', text, href }]
 */
function collectContactSegments(profile, styleSpec) {
    const primary = [];
    const urls = [];
    const specFields = Array.isArray(styleSpec?.contact_fields) ? styleSpec.contact_fields : null;

    const pushEmail = () => {
        if (!profile.email) return;
        const text = plainContactText(profile.email);
        if (!text) return;
        primary.push({ kind: 'email', text, href: `mailto:${text}` });
    };
    const pushPhone = () => {
        if (!profile.phone) return;
        const text = String(profile.phone).trim();
        if (text) primary.push({ kind: 'text', text });
    };
    const pushUrl = (raw) => {
        const text = normalizeContactUrl(raw);
        if (!text) return;
        const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        urls.push({ kind: 'url', text, href });
    };

    if (specFields) {
        for (const f of specFields) {
            if (!f || f.visible === false) continue;
            const src = f.source;
            if (src === 'city_state') pushCityState(primary, profile);
            else if (src === 'email') pushEmail();
            else if (src === 'phone') pushPhone();
            else if (src === 'linkedin_url' && profile.linkedin_url) pushUrl(profile.linkedin_url);
            else if (src === 'github_url' && profile.github_url) pushUrl(profile.github_url);
        }
    } else {
        pushCityState(primary, profile);
        pushEmail();
        pushPhone();
        if (profile.linkedin_url) pushUrl(profile.linkedin_url);
        if (profile.github_url) pushUrl(profile.github_url);
    }

    // Recover email kind if plain text slipped through as email-shaped.
    for (const p of primary) {
        if (p.kind === 'text' && isEmailLike(p.text)) {
            p.kind = 'email';
            p.href = `mailto:${p.text}`;
        }
    }

    return {
        primary: primary.filter((p) => p && p.text),
        urls: urls.filter((u) => u && u.text && u.href),
        separator: contactSeparator(styleSpec)
    };
}

/** Plain string lines (for LLM prompt + legacy callers). */
function collectContactLines(profile, styleSpec) {
    const { primary, urls, separator } = collectContactSegments(profile, styleSpec);
    return {
        primary: primary.map((p) => p.text),
        urls: urls.map((u) => u.text),
        separator
    };
}

function collectRawContactLines(profile, styleSpec) {
    return collectContactLines(profile, styleSpec);
}

function escapeHtmlAttr(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeHtmlText(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * HTML contact after <h1>: primary line + each URL on its own <p>.
 * Email / LinkedIn / GitHub are real <a href> hyperlinks.
 */
function buildContactHtml(profile, styleSpec) {
    const { primary, urls, separator } = collectContactSegments(profile, styleSpec);
    const parts = [];
    if (primary.length) {
        const joined = primary.map((p) => {
            if (p.kind === 'email' && p.href) {
                return `<a href="${escapeHtmlAttr(p.href)}">${escapeHtmlText(p.text)}</a>`;
            }
            return escapeHtmlText(p.text);
        }).join(` ${separator} `);
        parts.push(`<p>${joined}</p>`);
    }
    for (const u of urls) {
        parts.push(`<p><a href="${escapeHtmlAttr(u.href)}">${escapeHtmlText(u.text)}</a></p>`);
    }
    return parts.length ? `${parts.join('\n')}\n\n` : '';
}

/** Prompt lines for the LLM (plain text — we inject real links post-process). */
function buildContactPromptHint(profile, styleSpec) {
    const { primary, urls, separator } = collectContactLines(profile, styleSpec);
    const lines = [];
    if (primary.length) lines.push(primary.join(` ${separator} `));
    for (const u of urls) lines.push(u);
    return lines;
}

module.exports = {
    contactSeparator,
    stripContactLinks,
    normalizeContactUrl,
    plainContactText,
    collectContactSegments,
    collectRawContactLines,
    collectContactLines,
    buildContactHtml,
    buildContactPromptHint
};
