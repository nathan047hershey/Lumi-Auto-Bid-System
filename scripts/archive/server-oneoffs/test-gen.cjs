// Render a full DOCX buffer with the live renderer + the latest
// profile, save it to /tmp, then dump the docx/numbering-relevant
// bits so we can see the name size, contact duplication, and spacing.
const fs = require('fs');
const { initDatabase, getOne } = require('/var/www/myapp/job-apply/server/config/database');
const templateService = require('/var/www/myapp/job-apply/server/services/templateService');
const renderer = require('/var/www/myapp/job-apply/server/services/templateRenderer');

(async () => {
    await initDatabase();
    const profile = getOne("SELECT * FROM candidate_profiles WHERE id = 1");
    if (!profile) { console.error('No profile'); process.exit(1); }

    // Build a realistic resume HTML as the AI would produce
    const resumeHtml = '<h1>' + profile.first_name + ' ' + profile.last_name + '</h1>' +
        '<p>Houston, Texas | ' + profile.email + ' | ' + profile.phone + ' | linkedin.com/in/example</p>' +
        '<h2>Summary</h2><p>Senior engineer with React experience.</p>' +
        '<h2>Core Skills</h2><ul><li>JavaScript</li><li>TypeScript</li><li>React</li></ul>' +
        '<h2>Experience</h2><p><strong>Engineer | Acme | Remote | 2020 - 2024</strong></p><ul><li>Worked.</li></ul>' +
        '<h2>Education</h2><p><strong>BS CS | MIT | 2015 - 2019</strong></p>';

    // Render with default template (id 1)
    const styleSpec = templateService.resolveStyleSpec({ templateId: 1 });
    const buf = await renderer.buildDocx({ resumeHtml, profile, styleSpec, font: 'Arial' });
    fs.writeFileSync('/tmp/regenerated-resume.docx', buf);
    console.log('Wrote DOCX', buf.length, 'bytes');

    // Inspect the rendered text via the docx npm package
    const AdmZip = require('/var/www/myapp/job-apply/server/node_modules/adm-zip');
    const zip = new AdmZip(buf);
    const doc = zip.getEntry('word/document.xml').getData().toString('utf8');

    // Show top-of-doc paragraphs (name, contact, h2, body, bullets)
    const firstParas = doc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
    console.log('\n--- First 6 paragraphs in DOCX ---');
    for (let i = 0; i < Math.min(6, firstParas.length); i++) {
        const para = firstParas[i];
        const textMatch = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        const text = textMatch.map(m => m.replace(/<\/?w:t[^>]*>/g, '')).join('');
        const sizeMatch = para.match(/<w:sz w:val="(\d+)"/);
        const sz = sizeMatch ? (parseInt(sizeMatch[1]) / 2) + 'pt' : '?';
        const gap = para.match(/<w:spacing[^/]*\/>/g) || [];
        const align = /<w:jc w:val="center"/.test(para) ? 'center'
            : /<w:jc w:val="right"/.test(para) ? 'right'
            : /<w:jc w:val="both"/.test(para) ? 'justify' : 'left';
        console.log(' #' + i + ' size=' + sz + ' align=' + align + ' text="' + text.slice(0, 60) + '"');
        gap.forEach(g => console.log('      spacing:', g));
    }
    process.exit(0);
})();

