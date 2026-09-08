// Add a /settings/test endpoint and include api_key_status in GET /settings
const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');

// 1. Enhance GET /settings to include api_key_status
const oldGet = `router.get('/settings', (req, res) => { try { const settings = settingsService.getSettings(); res.json({ ai_provider: settings.ai_provider, updated_at: settings.updated_at, updated_by: settings.updated_by }); } catch (error) { console.error('Get settings error:', error); res.status(500).json({ error: 'Failed to load settings' }); } });`;

const newGet = `router.get('/settings', (req, res) => { try { const settings = settingsService.getSettings(); const cfg = settingsService.PROVIDER_CONFIG[settings.ai_provider]; const envKey = cfg ? process.env[cfg.apiKeyEnv] : null; const isPlaceholder = !envKey || /your[-_]?(api[-_]?)?key/i.test(String(envKey).trim()) || String(envKey).trim() === ''; const api_key_status = { env_var: cfg ? cfg.apiKeyEnv : null, is_set: Boolean(envKey && !isPlaceholder), is_placeholder: isPlaceholder, model: cfg ? cfg.defaultModel : null }; res.json({ ai_provider: settings.ai_provider, updated_at: settings.updated_at, updated_by: settings.updated_by, api_key_status }); } catch (error) { console.error('Get settings error:', error); res.status(500).json({ error: 'Failed to load settings' }); } });

// POST /api/admin/settings/test — verifies the configured provider's API key
// works by issuing a tiny chat completion request. Returns 200 on success,
// 400/500 with a human-readable message otherwise. This is what the admin
// UI calls when the user clicks "Test connection" in Settings.
router.post('/settings/test', async (req, res) => {
    try {
        const settings = settingsService.getSettings();
        const cfg = settingsService.getProviderConfig(settings.ai_provider);
        const axios = require('axios');
        const response = await axios.post(cfg.apiUrl, {
            model: cfg.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5
        }, {
            headers: {
                'Authorization': 'Bearer ' + cfg.apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            validateStatus: () => true
        });
        if (response.status >= 200 && response.status < 300) {
            res.json({ ok: true, provider: cfg.provider, model: cfg.model, message: 'API key works' });
        } else {
            const body = response.data;
            const msg = (body && (body.error?.message || body.message)) || JSON.stringify(body);
            res.status(response.status).json({ ok: false, provider: cfg.provider, model: cfg.model, error: msg, status: response.status });
        }
    } catch (error) {
        console.error('Settings test error:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: msg });
    }
});`;

if (c.includes(oldGet)) {
    c = c.replace(oldGet, newGet);
    console.log('Updated GET /settings with api_key_status');
    console.log('Added POST /settings/test endpoint');
} else {
    console.log('Could not find old settings route');
}

fs.writeFileSync(p, c);
console.log('Done.');
