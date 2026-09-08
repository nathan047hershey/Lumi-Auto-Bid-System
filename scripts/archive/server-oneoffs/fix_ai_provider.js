// Script: Switch default AI provider from 'deepseek' to 'minimax'
// so resume generation uses MiniMax-M2.7 model by default.

const { initDatabase, getOne, runQuery, saveDatabase } = require('./config/database');

(async () => {
    try {
        await initDatabase();
        const current = getOne("SELECT ai_provider FROM app_settings WHERE id = 1");
        if (current && current.ai_provider === 'minimax') {
            console.log('AI provider already set to minimax.');
        } else {
            runQuery("UPDATE app_settings SET ai_provider = 'minimax', updated_at = CURRENT_TIMESTAMP WHERE id = 1");
            saveDatabase();
            console.log('Updated AI provider from "deepseek" to "minimax" (MiniMax-M2.7).');
        }
        const row = getOne("SELECT ai_provider FROM app_settings WHERE id = 1");
        console.log('Current ai_provider:', row?.ai_provider);
    } catch (e) {
        console.error('Error:', e.message);
    }
})();
