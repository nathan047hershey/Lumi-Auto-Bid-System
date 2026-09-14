/**
 * Test: Can the admin call /api/user/outlook/auth-url?
 * Should return a JSON with authorizeUrl.
 */
const axios = require('axios');

async function main() {
    try {
        // 1. Login as admin
        const loginRes = await axios.post('http://localhost:9017/auth/login', {
            username: 'admin',
            password: 'admin123'
        });
        const token = loginRes.data.token;
        console.log('✅ Login OK, token length:', token.length);

        // 2. Call the auth-url endpoint
        const authRes = await axios.post('http://localhost:9017/api/user/outlook/auth-url', {
            login_hint: 'test@outlook.com',
            select_account: true
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ Auth URL endpoint works!');
        console.log('Response:', JSON.stringify(authRes.data, null, 2));
    } catch (err) {
        console.error('❌ Error:', err.response?.status, err.response?.data || err.message);
    }
}

main();