/**
 * Drive fill.js against the local autofill fixture.
 */
const path = require('path');
const fs = require('fs');

module.exports = async function (page) {
    const fillSrc = fs.readFileSync(path.resolve(__dirname, '../content/fill.js'), 'utf8');

    await page.evaluate(() => {
        window.__JOB_APPLY_BIDDER_FILL__ = false;
        window.chrome = {
            runtime: {
                id: 'fixture-test',
                onMessage: {
                    _listeners: [],
                    addListener(fn) { this._listeners.push(fn); }
                }
            }
        };
    });

    await page.evaluate((src) => {
        // eslint-disable-next-line no-eval
        eval(src);
    }, fillSrc);

    async function send(msg) {
        return page.evaluate((message) => {
            return new Promise((resolve) => {
                const listeners = window.chrome.runtime.onMessage._listeners || [];
                if (!listeners.length) {
                    resolve({ ok: false, error: 'no listener' });
                    return;
                }
                const ret = listeners[0](message, {}, (payload) => resolve(payload));
                if (ret === true) return;
                // sync response path
            });
        }, msg);
    }

    const form = await send({ type: 'COLLECT_FORM' });
    if (!form?.ok) {
        return { ok: false, stage: 'collect', form };
    }

    const qWhy = form.data.questions.find((q) => /why/i.test(q.label));
    const qAuth = form.data.questions.find((q) => /authorized/i.test(q.label));
    const qSal = form.data.questions.find((q) => /salary/i.test(q.label));

    const answers = [
        qWhy && { id: qWhy.id, answer: 'I want to build React services at Acme.' },
        qAuth && { id: qAuth.id, answer: 'Yes' },
        qSal && { id: qSal.id, answer: '$180,000' }
    ].filter(Boolean);

    const profile = {
        first_name: 'Bob',
        last_name: 'Demo',
        email: 'bob@example.com',
        phone: '555-0100',
        linkedin_url: 'https://linkedin.com/in/bob',
        salary_range: '180000'
    };

    const base64 = Buffer.from('PK fake resume').toString('base64');
    const fill = await send({
        type: 'FILL_FORM',
        payload: {
            fields: form.data.fields,
            answers,
            profile,
            jobDescription: 'Compensation: $140,000 - $180,000 USD.',
            fileInputs: form.data.fileInputs,
            filename: 'resume.docx',
            base64,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            autoSubmit: false
        }
    });

    const values = await page.evaluate(() => ({
        first_name: document.getElementById('first_name').value,
        last_name: document.getElementById('last_name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        linkedin: document.getElementById('linkedin').value,
        salary: document.getElementById('salary').value,
        why: document.getElementById('why').value,
        auth: document.getElementById('auth').value,
        resumeFiles: document.getElementById('resume').files?.length || 0
    }));

    const expected = {
        first_name: 'Bob',
        last_name: 'Demo',
        email: 'bob@example.com',
        phone: '555-0100',
        linkedin: 'https://linkedin.com/in/bob',
        salary: '$180,000',
        why: 'I want to build React services at Acme.',
        auth: 'Yes',
        resumeFiles: 1
    };

    const mismatches = Object.keys(expected).filter((k) => values[k] !== expected[k]);

    return {
        ok: mismatches.length === 0 && !!fill?.ok,
        collect: {
            ats: form.data.ats,
            fields: form.data.fields.map((f) => ({ id: f.id, kind: f.kind, label: f.label })),
            questions: form.data.questions.map((q) => q.label),
            fileInputs: form.data.fileInputs.length
        },
        fillStats: fill?.fillStats,
        uploadStats: fill?.uploadStats,
        values,
        expected,
        mismatches,
        fillError: fill?.error || null
    };
};
