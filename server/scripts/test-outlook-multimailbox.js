/**
 * test-outlook-multimailbox.js
 * Comprehensive test for Outlook/Graph multi-mailbox setup.
 *
 * Usage:
 *   node test-outlook-multimailbox.js [user_id]
 */
require('dotenv').config();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { initDatabase } = require('../config/database');
const outlookMail = require('../services/outlookMailService');

async function test1_configValidation() {
    console.log('\n=== TEST 1: Configuration Validation ===');
    const v = outlookMail.validateConfig();
    console.log('OK:', v.ok);
    console.log('Config:', JSON.stringify(v.config, null, 2));
    if (v.errors.length) {
        console.log('ERRORS:');
        for (const e of v.errors) console.log('  ❌ ' + e);
    }
    if (v.warnings.length) {
        console.log('WARNINGS:');
        for (const w of v.warnings) console.log('  ⚠️  ' + w);
    }
    return v.ok;
}

async function test2_firstPartyCheck() {
    console.log('\n=== TEST 2: Microsoft First-Party Detection ===');
    const cid = String(process.env.OUTLOOK_CLIENT_ID || '').toLowerCase().trim();
    const knownFirstParty = {
        '1950a258-227b-4e35-a9ae-242ffffdd7b0': 'MS Graph PowerShell',
        'd3590ed6-520b-423d-b2cf-5a4d4bf8044d': 'Visual Studio',
        '04b07795-8ddb-461a-bbee-02f9e1bf7b46': 'Azure CLI',
        '00000002-0000-0ff1-ce00-000000000000': 'Office365 Exchange'
    };
    if (knownFirstParty[cid]) {
        console.log(`❌ DANGER: Your Client ID is Microsoft's ${knownFirstParty[cid]} app!`);
        console.log('   This will cause "first_party_app" errors. Use your own app registration.');
        return false;
    }
    console.log('✅ Client ID is not a known Microsoft first-party app.');
    return true;
}

async function test3_deviceCode() {
    console.log('\n=== TEST 3: Device Code Endpoint ===');
    try {
        const started = await outlookMail.startDeviceCode();
        console.log('✅ Device code endpoint works!');
        console.log('  User code:', started.user_code);
        console.log('  Verification URI:', started.verification_uri);
        console.log('  Expires in:', started.expires_in, 's');
        console.log('  Interval:', started.interval, 's');
        console.log('  ⚠️  DO NOT complete this sign-in. Code expires in 15 min.');
        return true;
    } catch (err) {
        console.log('❌ Device code FAILED:', err.message);
        if (err.code) console.log('  Microsoft code: AADSTS' + err.code);
        return false;
    }
}

async function test4_listMailboxes(userId) {
    console.log('\n=== TEST 4: List Connected Mailboxes ===');
    if (!userId) {
        console.log('⏭️  Skipped (provide user_id as argument)');
        return [];
    }
    const uid = parseInt(userId, 10);
    const boxes = outlookMail.listMailboxesPublic(uid);
    console.log(`Found ${boxes.length} mailbox(es):`);
    for (const b of boxes) {
        console.log(`  - ID:${b.id} | ${b.email} | ${b.display_name || 'no name'}`);
    }
    return boxes;
}

async function test5_healthCheck(userId) {
    console.log('\n=== TEST 5: Health Check ===');
    if (!userId) {
        console.log('⏭️  Skipped (provide user_id as argument)');
        return [];
    }
    const uid = parseInt(userId, 10);
    const health = await outlookMail.healthCheckAll(uid);
    const emoji = {
        healthy: '✅', needs_refresh: '🔄',
        expired: '⏰', error: '❌', disconnected: '🔌'
    };
    for (const h of health) {
        console.log(`  ${emoji[h.health] || '❓'} ID:${h.mailbox_id} | ${h.email} | ${h.health}`);
        if (h.last_error) console.log(`      Error: ${h.last_error}`);
    }
    return health;
}

async function main() {
    const userId = process.argv[2] || null;
    console.log('╔════════════════════════════════════════╗');
    console.log('║  Outlook Multi-Mailbox Test Suite      ║');
    console.log('╚════════════════════════════════════════╝');

    // Initialize database first
    try {
        await initDatabase();
        console.log('✅ Database initialized\n');
    } catch (err) {
        console.error('❌ Database init failed:', err.message);
        process.exit(1);
    }

    let allOk = true;
    allOk = (await test1_configValidation()) && allOk;
    allOk = (await test2_firstPartyCheck()) && allOk;
    const devOk = await test3_deviceCode();
    await test4_listMailboxes(userId);
    await test5_healthCheck(userId);

    console.log('\n=== SUMMARY ===');
    console.log(allOk ? '✅ Config OK' : '❌ Config has errors');
    console.log(devOk ? '✅ Device code endpoint works' : '⚠️  Device code endpoint may have issues');
    console.log('\nNext steps:');
    console.log('1. Fix any errors shown above');
    console.log('2. In Azure portal: enable public client flows + add API permissions + grant admin consent');
    console.log('3. Update server/.env with your Client ID');
    console.log('4. Restart server: npm run dev');
    console.log('5. In Lumi UI: Auto Bidder → Add mailbox → complete device login');
    console.log('6. Add multiple mailboxes (Jonathan, Blake, etc.)');
    console.log('7. Run this script with user_id for health check');
    console.log('\nUsage: node test-outlook-multimailbox.js [user_id]');
}

main().catch((err) => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});