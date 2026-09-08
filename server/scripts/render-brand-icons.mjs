#!/usr/bin/env node
/**
 * Render brand SVG to PNG sizes for the Chrome extension toolbar.
 * Usage: node server/scripts/render-brand-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const svgPath = path.join(root, 'client', 'public', 'brand', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>/i, '').trim();
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#fff">${svg}</body></html>`;

const outDir = path.join(root, 'extension', 'icons');
const sizes = [16, 48, 128];

const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH
        || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

for (const size of sizes) {
    await page.evaluate((s) => {
        const el = document.querySelector('svg');
        if (el) {
            el.setAttribute('width', String(s));
            el.setAttribute('height', String(s));
        }
        document.body.style.width = `${s}px`;
        document.body.style.height = `${s}px`;
    }, size);
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const png = await page.screenshot({
        type: 'png',
        omitBackground: false,
        clip: { x: 0, y: 0, width: size, height: size }
    });
    const out = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(out, png);
    console.log('wrote', out);
}

await browser.close();
