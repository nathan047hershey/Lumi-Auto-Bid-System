const jwt = require('jsonwebtoken');
const axios = require('axios');
process.chdir('/var/www/myapp/job-apply/server');
const token = jwt.sign({id: 17, username: 'Dash', role: 'user'}, 'job-apply-secret-key-change-in-production', {expiresIn: '1h'});
(async () => {
  try {
    const res = await axios.post('http://localhost:8001/user/generate-resume', {
      profile_id: 32,
      job_description: 'Test job description for skill validation.',
      company_name: 'Test Co',
      job_role: 'Engineer',
      core_skills: '.NET, Python',
      job_url: 'https://example.com/job'
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 120000 });
    console.log('Status:', res.status);
    console.log('Keys:', Object.keys(res.data));
    console.log('application_id:', res.data.application_id);
    console.log('company_name:', res.data.company_name);
  } catch (e) {
    console.log('Error:', e.response?.status, e.response?.data || e.message);
  }
})();
