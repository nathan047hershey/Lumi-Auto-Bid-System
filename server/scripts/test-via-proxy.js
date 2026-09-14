/**
 * Test: Simulates what the browser does through Vite proxy
 * - Calls /api/user/outlook/auth-url via Vite (port 5173)
 * - Vite strips /api and forwards to backend (port 9017) as /user/outlook/auth-url
 */
const axios = require('axios');

async function main() {
    try {
        // 1. Login as admin via Vite (port 5173)
        const loginRes = await axios.post('http://localhost:5173/api/auth/login', {
            username: 'admin',
            password: 'admin123'
        });
        const token = loginRes.data.token;
        console.log('✅ Login OK, token length:', token.length);

        // 2. Call the auth-url endpoint via Vite proxy
        const authRes = await axios.post('http://localhost:5173/api/user/outlook/auth-url', {
            login_hint: 'test@outlook.com',
            select_account: true
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ Auth URL endpoint works!');
        console.log('Response:', JSON.stringify(authRes.data, null, 2).substring(0, 300));
    } catch (err) {
        console.error('❌ Error:', err.response?.status, err.response?.data?.substring(0, 500) || err.message);
    }
}

main();