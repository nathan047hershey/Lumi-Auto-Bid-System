const fs = require('fs');
const path = require('path');
const templateRenderer = require('./templateRenderer');
const templateService = require('./templateService');

let browserInstance = null;

function docxFilenameToPdfFilename(docxFilename) {
    if (!docxFilename) return null;
    return String(docxFilename).replace(/\.docx$/i, '.pdf');
}

function findChromiumExecutable() {
    const candidates = [
        process.env.CHROMIUM_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        candidates.push(
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        );
    }

    return candidates.find((p) => {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    }) || null;
}

function buildPrintHtml(resumeHtml, styleSpec, font) {
    const normalizedFont = templateService.normaliseFontName(font) || 'Arial';
    const templateCss = templateRenderer.buildPdfCss(styleSpec, normalizedFont);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>Resume</title>
<style>
    @page { size: A4; margin: 12mm; }
    html, body { margin: 0; padding: 0; background: #ffffff; color: #000000; }
    ${templateCss}
    h2 { page-break-after: avoid; }
    li { page-break-inside: avoid; }
    a { color: #000; text-decoration: none; }
</style>
</head>
<body>
${resumeHtml}
</body>
</html>`;
}

async function getBrowser() {
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
        throw new Error(
            'No Chromium/Chrome/Edge binary found. Install Google Chrome or Microsoft Edge, ' +
            'or set CHROMIUM_PATH in server/.env to the browser executable.'
        );
    }

    if (browserInstance && browserInstance.connected) {
        return browserInstance;
    }

    const puppeteer = await import('puppeteer-core');
    browserInstance = await puppeteer.default.launch({
        executablePath,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--font-render-hinting=none'
        ]
    });

    browserInstance.on('disconnected', () => {
        browserInstance = null;
    });

    return browserInstance;
}

async function renderResumePdfBuffer({ resumeHtml, styleSpec, font = 'Arial' }) {
    if (!resumeHtml || typeof resumeHtml !== 'string') {
        throw new Error('resumeHtml is required');
    }

    const printHtml = buildPrintHtml(resumeHtml, styleSpec, font);
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setContent(printHtml, { waitUntil: 'load', timeout: 30000 });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }
        });
        return pdfBuffer;
    } finally {
        await page.close().catch(() => {});
    }
}

async function writePdfAlongsideDocx({
    resumesDir,
    docxFilename,
    resumeHtml,
    styleSpec,
    font = 'Arial'
}) {
    if (!resumesDir || !docxFilename || !resumeHtml) return null;

    try {
        const pdfBuffer = await renderResumePdfBuffer({ resumeHtml, styleSpec, font });
        const pdfFilename = docxFilenameToPdfFilename(docxFilename);
        fs.writeFileSync(path.join(resumesDir, pdfFilename), pdfBuffer);
        return pdfFilename;
    } catch (err) {
        console.warn('[resumePdf] could not write PDF alongside DOCX:', err.message);
        return null;
    }
}

async function closeBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.close();
        } catch (_) { /* noop */ }
        browserInstance = null;
    }
}

module.exports = {
    docxFilenameToPdfFilename,
    findChromiumExecutable,
    buildPrintHtml,
    renderResumePdfBuffer,
    writePdfAlongsideDocx,
    closeBrowser
};
