export default async function (page) {
  const payload = {"profile":{"first_name":"Vinh","last_name":" Ly","email":"vily437@outlook.com","phone":"(318) 202-8037","work_authorization":"","salary_range":"180000"},"answers":[{"id":"q_sal","label":"Expected salary / compensation","answer":"$180,000","salary_meta":{"source":"jd_profile_overlap","value":180000,"jdRange":{"min":140000,"max":180000},"profileRange":{"min":180000,"max":180000}}},{"id":"q_why","label":"Why do you want this role?","answer":"I am excited about the opportunity to join Acme as a Software Engineer because I am impressed by the company's focus on building scalable and secure React and Node services. With 5 years of experience in building APIs and UI for SaaS products using React and Node.js, I am confident that I can make a significant contribution to the team. I am particularly drawn to Acme's commitment to innovation and customer satisfaction, and I am eager to be a part of a team that is shaping the future of software development. I am also impressed by the company's emphasis on collaboration and teamwork, and I am excited about the opportunity to work with a talented team of engineers to build cutting-edge software solutions.","answer_type":"written","source":"api"},{"id":"q_react","label":"Years of experience with React","answer":"5","answer_type":"written","source":"api"}],"jobDescription":"Software Engineer at Acme. Build React and Node services. Compensation: $140,000 - $180,000 USD. Must be authorized to work in the US. 3+ years experience preferred."};
  await page.waitForSelector('#apply');
  const result = await page.evaluate((p) => {
    function setVal(sel, value) {
      const el = document.querySelector(sel);
      if (!el || value == null || value === '') return false;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const byId = Object.fromEntries((p.answers || []).map((a) => [a.id, a.answer]));
    const filled = {
      first_name: setVal('#first_name', p.profile.first_name),
      last_name: setVal('#last_name', p.profile.last_name),
      email: setVal('#email', p.profile.email),
      phone: setVal('#phone', p.profile.phone),
      q_why: setVal('#q_why', byId.q_why || ''),
      q_sal: setVal('#q_sal', byId.q_sal || ''),
      q_auth: setVal('#q_auth', byId.q_auth || p.profile.work_authorization || ''),
      q_react: setVal('#q_react', byId.q_react || '')
    };
    const values = {
      first_name: document.querySelector('#first_name').value,
      last_name: document.querySelector('#last_name').value,
      email: document.querySelector('#email').value,
      phone: document.querySelector('#phone').value,
      q_why: document.querySelector('#q_why').value,
      q_sal: document.querySelector('#q_sal').value,
      q_auth: document.querySelector('#q_auth').value,
      q_react: document.querySelector('#q_react').value
    };
    return { filled, values };
  }, payload);
  return result;
}
