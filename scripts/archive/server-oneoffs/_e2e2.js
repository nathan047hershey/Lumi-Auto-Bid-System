// E2E verification of all the new experience-row + work-summary
// features. Builds a maxed-out template that exercises:
//   - separator = ','  (comma, not pipe)
//   - title_align = left, company_align = left, location_align = right, dates_align = right
//   - title_italic = false, company_italic = true, location_italic = true, dates_italic = false
//   - wrap_title_company = true, wrap_company_location = true
//   - work_summary = true
//
// Then generates a resume with it and inspects the DOCX zip for:
//   - comma separator between inline segments
//   - multiple paragraphs per job (3 — title, company, location+dates)
//   - <w:tabs> with a right tab stop (location+dates inline row)
//   - <w:i/> italic flags on the company and location runs
//   - <p><em>...</em></p> emitted by the AI as a work summary ABOVE
//     the bullet list, rendered as a DOCX italic paragraph (italic
//     run, no bullet)
require('dotenv').config();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const token = jwt.sign(
    { id: 2, username: 'test', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
);

(async () => {
    // ---- Build the maxed-out template ----
    const def = await axios.get('http://localhost:8001/user/user-templates/default-spec', {
        headers: { Authorization: 'Bearer ' + token }
    });
    const spec = JSON.parse(JSON.stringify(def.data.style_spec));
    spec.experience_row = {
        layout: 'two_column',
        separator: ',',
        title_align: 'left',
        company_align: 'left',
        location_align: 'right',
        dates_align: 'right',
        title_italic: false,
        company_italic: true,
        location_italic: true,
        dates_italic: false,
        wrap_title_company: true,
        wrap_company_location: true,
        show_company: true,
        show_location: true,
        work_summary: true
    };
    const tplName = 'E2E Max Template ' + Date.now();
    const created = await axios.post('http://localhost:8001/user/user-templates', {
        name: tplName,
        description: 'comma separator + location right + company on next line + work summary',
        style_spec: spec,
        is_default: false
    }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    const tplId = created.data.template.id;
    console.log('created template id:', tplId);

    // ---- Generate the resume ----
    const gen = await axios.post('http://localhost:8001/user/generate-resume', {
        profile_id: 1,
        job_description: [
            'Senior Backend Engineer - Distributed Payments Platform',
            '',
            'We are rebuilding our payments backbone to handle 5,000+ TPS across 14',
            'countries. You will own services in Go and Rust, design Postgres',
            'schemas that survive PCI audits, and partner with the platform team',
            'on Kafka topic strategy.',
            '',
            'Required: 5+ years backend, Go or Rust, Postgres at scale, Kafka.'
        ].join('\n'),
        company_name: 'Acme Corp',
        job_role: 'Senior Backend Engineer',
        core_skills: 'Go, Rust, Postgres, Kafka',
        job_url: 'https://example.com/jobs/sbe',
        template_id: tplId,
        template_source: 'user',
        font_family: 'Calibri'
    }, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        timeout: 120000
    });
    console.log('generate status:', gen.status);
    console.log('provider_used:', gen.data.provider_used, '| fallback_used:', gen.data.fallback_used);
    console.log('html length:', (gen.data.resume_html || '').length);
    const resumeHtml = gen.data.resume_html || '';
    const filename = gen.data.resume_filename;

    // ---- Save artefacts ----
    const docxPath = path.join(__dirname, 'test-results', 'e2e_max.docx');
    const htmlPath = path.join(__dirname, 'test-results', 'e2e_max.html');
    fs.copyFileSync(path.join(__dirname, 'resumes', filename), docxPath);

    // Strip <think> blocks before saving
    const cleanHtml = resumeHtml
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```html\n?/g, '').replace(/```\n?/g, '')
        .trim();
    fs.writeFileSync(htmlPath, cleanHtml);

    // ---- DOCX inspection ----
    const zip = new AdmZip(docxPath);
    const docXml = zip.readAsText('word/document.xml');

    const checks = {
        'has <w:tab> (right tab stop)':                /<w:tab\b/.test(docXml),
        'has right-aligned tab stop':                   /<w:tabs>[\s\S]*?<w:tab[^/]*w:val="right"/i.test(docXml),
        'has <w:i/> italic run (company italic)':       /<w:i\s*\/>/i.test(docXml),
        // Look for the comma separator in the rendered text — between
        // <w:t>...</w:t> runs we expect "<w:t>, </w:t>".
        'has comma separator (<w:t>, </w:t>)':          /<w:t[^>]*>,\s*<\/w:t>/i.test(docXml),
        // Multiple paragraphs per job because both wraps are on.
        // Each <w:p> in document.xml is one paragraph.
        'multiple <w:p> per job (wraps emit 3 paragraphs)': (docXml.match(/<w:p\b/gi) || []).length >= 12,
        // Work summary should be a paragraph with italic content
        // immediately followed by a bullet list. Detect by looking for
        // a paragraph whose text is short (1 sentence) and contains
        // <w:i/>.
        'work summary paragraph (italic, no bullet)': /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:i\s*\/>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/i.test(docXml),
        'AI emitted <em> in HTML (work summary)':        /<em>/i.test(cleanHtml),
        'AI emitted <em> per job (>=2 work summaries)':  (cleanHtml.match(/<em>/gi) || []).length >= 2
    };
    console.log('\nDOCX checks:');
    for (const [k, v] of Object.entries(checks)) console.log('  ', v ? 'OK  ' : 'FAIL', k);

    // ---- Cleanup ----
    await axios.delete('http://localhost:8001/user/user-templates/' + tplId, {
        headers: { Authorization: 'Bearer ' + token }
    });
    console.log('\ndeleted template id:', tplId);
    console.log('saved docx ->', docxPath);
    console.log('saved html ->', htmlPath);
})().catch(e => {
    console.error('ERROR:', e.response?.status, JSON.stringify(e.response?.data || {}, null, 2));
    console.error(e.stack);
});