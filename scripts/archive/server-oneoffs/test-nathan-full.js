// One-off diagnostic: invoke the AI provider DIRECTLY with Nathan
// Hershey's real `resume_prompt` background + a custom job description,
// then save the ENTIRE raw response (status, headers, usage, reasoning,
// content, finish_reason, all metadata) to a file.
//
// Mirrors what `makeApiCallWithRetry` does inside `generateResume`,
// but skips the resume-pipeline post-processing so you can inspect
// the full upstream payload verbatim.
//
// Output: writes JSON to /tmp/nathan_ai_full_response.json and prints
// a small summary to stdout.

process.chdir('/var/www/myapp/job-apply/server');
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const PROVIDERS = {
    deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiUrl: 'https://api.deepseek.com/v1/chat/completions',
        defaultModel: 'deepseek-reasoner'
    },
    minimax: {
        apiKeyEnv: 'MINIMAX_API_KEY',
        apiUrl: 'https://api.minimax.io/v1/chat/completions',
        // Matches the override generateResume uses for MiniMax.
        defaultModel: 'MiniMax-M2.7-highspeed'
    }
};

const providerName = (process.argv[2] || 'minimax').toLowerCase();
const cfg = PROVIDERS[providerName];
if (!cfg) {
    console.error(`Unknown provider '${providerName}'. Use: deepseek | minimax`);
    process.exit(1);
}
const apiKey = process.env[cfg.apiKeyEnv];
if (!apiKey) {
    console.error(`Missing env ${cfg.apiKeyEnv}`);
    process.exit(1);
}

// ---- Pull Nathan's profile from SQLite so we use the REAL resume_prompt ----
const initSqlJs = require('sql.js');
const DB_PATH = require('path').join(__dirname, 'database.sqlite');

(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));
    const res = db.exec(`SELECT * FROM candidate_profiles WHERE id = 2`);
    if (!res[0]) {
        console.error('Profile id=2 (Nathan Hershey) not found');
        process.exit(1);
    }
    const cols = res[0].columns;
    const vals = res[0].values[0];
    const profile = {};
    cols.forEach((c, i) => { profile[c] = vals[i]; });

    console.log(`Loaded profile: id=${profile.id} name=${profile.first_name} ${profile.last_name}`);

    // ---- Build the same prompt structure generateResume uses ----
    const contactParts = [];
    if (profile.city || profile.state) contactParts.push(`${profile.city || ''}, ${profile.state || ''}`.trim().replace(/^,|,$/g, ''));
    if (profile.email) contactParts.push(profile.email);
    if (profile.phone) contactParts.push(profile.phone);
    if (profile.linkedin_url) contactParts.push(profile.linkedin_url);
    if (profile.github_url) contactParts.push(profile.github_url);

    // A trimmed version of the system prompt used by generateResume
    // (the real one is ~6 KB; the rules enforced by the pipeline's
    // post-processor are unaffected by what we put in the system
    // prompt, since the pipeline rewrites em-dashes, builds contact
    // from profile data, reorders sections, etc.).
    const systemPrompt = `You write resumes like a real human would — never like an AI.
Output ONLY clean HTML using <h1>, <h2>, <p>, <strong>, <ul>, <li>.
No class, no style, no span, no div. No <html>/<body> wrapper.
Section order: Summary -> Core Skills -> Work Experience -> Education.
Every <li> ends with a period.`;

    const customJobDescription = `
Staff Software Engineer - Marketplace Trust & Safety Platform

We are scaling the trust infrastructure that protects 40M+ monthly
buyers and sellers across our two-sided marketplace. You'll lead
backend work on the risk-scoring pipeline (Python + Go), own
Postgres schemas that survive regulatory audits, and partner with
ML engineers to productionize fraud-detection models. On-call
rotation is one week per quarter; we run multi-region active/active
on AWS.

Required: 6+ years backend, Python and/or Go, Postgres at scale,
Kafka or Kinesis, observability (Datadog or OpenTelemetry),
microservices, AWS. Bonus: marketplace / payments / risk domain,
fraud ML integration, multi-region AWS, PCI-DSS.
`.trim();

    // The userPrompt stitches Nathan's resume_prompt background with
    // the JD, the same way generateResume does.
    const userPrompt = `Generate resume for: ${profile.first_name} ${profile.last_name}.

Contact line to use (already built): ${contactParts.join(' | ')}

Background:
${profile.resume_prompt}

Target job:
${customJobDescription}

Write this resume the way a real senior engineer would describe their
own work. Plain English, specific, no buzzwords, no AI tells.

Output the resume body HTML only — start with <h1>${profile.first_name} ${profile.last_name}</h1>,
no <html>/<body> wrappers. Use ONLY <h1>, <h2>, <p>, <strong>, <ul>, <li>.
NO class, NO style, NO span, NO div.

For the Education section: use the format
<p><strong>Degree | School | StartYear - EndYear</strong></p>.
DO NOT include the school's city/location.`;

    const requestPayload = {
        model: cfg.defaultModel,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: 8000,
        temperature: 0.7
    };

    const startedAt = Date.now();
    const response = await axios.post(
        cfg.apiUrl,
        requestPayload,
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 90000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            decompress: true,
            validateStatus: () => true   // surface non-2xx as resolved
        }
    );
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

    // ---- Build the full saved payload ----
    const choice = response.data?.choices?.[0] || {};
    const msg = choice.message || {};

    const fullResponse = {
        _meta: {
            captured_at: new Date().toISOString(),
            elapsed_sec: Number(elapsed),
            provider: providerName,
            apiUrl: cfg.apiUrl,
            model_requested: cfg.defaultModel,
            profile: {
                id: profile.id,
                first_name: profile.first_name,
                last_name: profile.last_name,
                email: profile.email,
                city: profile.city,
                state: profile.state
            },
            custom_job_description: customJobDescription,
            request_payload: requestPayload
        },
        http: {
            status: response.status,
            status_text: response.statusText,
            headers: response.headers
        },
        response_data: response.data,
        derived: {
            finish_reason: choice.finish_reason,
            index: choice.index,
            message_role: msg.role,
            content_length: (msg.content || '').length,
            reasoning_length: (msg.reasoning_content || '').length,
            usage: response.data?.usage || null
        }
    };

    const outPath = '/tmp/nathan_ai_full_response.json';
    fs.writeFileSync(outPath, JSON.stringify(fullResponse, null, 2));

    console.log('---');
    console.log('provider        :', providerName);
    console.log('model           :', cfg.defaultModel);
    console.log('elapsed_sec     :', elapsed);
    console.log('http_status     :', response.status);
    console.log('finish_reason   :', choice.finish_reason);
    console.log('content_length  :', (msg.content || '').length);
    console.log('reasoning_length:', (msg.reasoning_content || '').length);
    console.log('usage           :', JSON.stringify(response.data?.usage || null));
    console.log('---');
    console.log('SAVED TO       :', outPath);
    console.log('FILE SIZE      :', fs.statSync(outPath).size, 'bytes');
})();