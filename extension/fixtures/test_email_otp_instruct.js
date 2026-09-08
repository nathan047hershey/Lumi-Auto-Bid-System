'use strict';
/**
 * Instruct Lumi — alphanumeric Greenhouse security codes (e.g. wFY53Ht3).
 * Run: node extension/fixtures/test_email_otp_instruct.js
 */
const path = require('path');
const assert = require('assert');

const {
    interpretFillInstruction
} = require(path.join(__dirname, '../../server/services/fillInstructionService'));

async function run() {
    const checks = [];
    const snap = [{ id: 'sec', label: 'Security code', empty: true, value: '' }];

    const cases = [
        ['this is code wFY53Ht3', 'wFY53Ht3'],
        ['code wFY53Ht3', 'wFY53Ht3'],
        ['security code is Ab12Cd34', 'Ab12Cd34'],
        ['wFY53Ht3', 'wFY53Ht3'],
        ['482913', '482913'],
        ['code 123456 and submit', '123456']
    ];

    for (const [instruction, expect] of cases) {
        const r = await interpretFillInstruction({
            instruction,
            fields: snap,
            missingRequired: ['Security code']
        });
        const ok = r?.ok === true
            && String(r.emailOtp || '') === expect
            && r.fills?.[0]?.answer_type === 'email_otp';
        checks.push([`parse "${instruction}" → ${expect}`, ok, r]);
        if (!ok) {
            console.log('FAIL detail', instruction, {
                ok: r?.ok,
                emailOtp: r?.emailOtp,
                summary: r?.summary,
                fills: r?.fills
            });
        }
    }

    // Must not strip letters (regression for old \\D-only path)
    const alpha = await interpretFillInstruction({
        instruction: 'this is code wFY53Ht3',
        fields: snap
    });
    checks.push([
        'alphanumeric kept (not digit-stripped to 533)',
        alpha?.emailOtp === 'wFY53Ht3' && !/^\d+$/.test(alpha.emailOtp)
    ]);

    const bareSubmit = await interpretFillInstruction({
        instruction: 'submit',
        fields: snap
    });
    checks.push([
        'bare submit asks for code when security empty',
        bareSubmit?.ok === false && /security code/i.test(bareSubmit?.summary || '')
    ]);

    let passed = 0;
    for (const [name, ok] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
        if (ok) passed += 1;
    }
    console.log(`\nEmail OTP instruct: ${passed}/${checks.length}`);
    if (passed < checks.length) process.exit(1);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
