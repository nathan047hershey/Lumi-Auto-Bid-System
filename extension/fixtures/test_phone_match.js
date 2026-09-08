'use strict';
/**
 * Unit check: phone format variants should match (Greenhouse verify).
 * Mirrors bidderFill phoneDigits + valuesMatch phone branch.
 */
function phoneDigits(s) {
  let d = String(s || '').replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

function phoneMatch(wanted, got) {
  const wd = phoneDigits(wanted);
  const gd = phoneDigits(got);
  if (!wd || !gd) return false;
  return wd === gd || wd.endsWith(gd) || gd.endsWith(wd);
}

const cases = [
  ['937-326-3137', '(937) 326-3137', true],
  ['9373263137', '(937) 326-3137', true],
  ['+1 937-326-3137', '937-326-3137', true],
  ['937-326-3137', '555-123-4567', false],
  ['', '(937) 326-3137', false]
];

let failed = 0;
for (const [w, g, expect] of cases) {
  const got = phoneMatch(w, g);
  if (got !== expect) {
    console.error('FAIL', w, g, 'expected', expect, 'got', got);
    failed += 1;
  } else {
    console.log('ok', w, '≈', g);
  }
}
process.exit(failed ? 1 : 0);
