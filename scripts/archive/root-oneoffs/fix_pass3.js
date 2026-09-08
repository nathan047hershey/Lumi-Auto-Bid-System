// Fix pass 3 regex to include 'minutes' as a non-ATS unit (don't convert)
const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/resumeService.js';
let c = fs.readFileSync(p, 'utf8');

// The current UNIT_PATTERN includes "h(?:ou)?rs?" (hours) but not
// "minutes". Replace it with a fuller list that ALSO includes minutes
// but EXCLUDES them from the conversion by NOT matching them in the
// numberWordRegex. We do this by adding a negative lookahead:
//
//   (NUMBER) (?=...) — only convert when followed by an ATS unit.
//
// A simpler approach: change the unit pattern to require ATS-relevant
// tokens only (years, %, +, seconds, ms, KB/MB/GB, $, engineers,
// services, etc.), and explicitly drop "minutes", "hours", "minutes"
// from the match. Below: only convert when followed by a known ATS
// unit, never for plain English time words.

const oldUnits = "const UNIT_PATTERN = '(?:years?|yrs?|%+|ms|s|min(?:ute)?s?|h(?:ou)?rs?|KB|MB|GB|TB|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|months?|weeks?|days?|times?|x|\\$|USD|projects?|bugs?|tests?|uptime)';";
const newUnits = "const UNIT_PATTERN = '(?:years?|yrs?|%+|ms|s|min(?:ute)?s?|h(?:ou)?rs?|KB|MB|GB|TB|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|months?|weeks?|days?|times?|x|\\$|USD|projects?|bugs?|tests?|uptime|core_skills?)';";

if (c.includes(oldUnits)) {
    c = c.replace(oldUnits, newUnits);
    console.log('Updated UNIT_PATTERN (added core_skills)');
}

// Actually the issue is we shouldn't match 'minutes' at all.
// Let's narrow the unit list and explicitly EXCLUDE 'minutes'.
const oldUnitString = `const UNIT_PATTERN = '(?:years?|yrs?|%|\\\\+|(?:milli|micro)?seconds?|ms|s|min(?:ute)?s?|h(?:ou)?rs?|KB|MB|GB|TB|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|months?|weeks?|days?|times?|x|\\\\$|USD|projects?|bugs?|tests?|uptime|core_skills?)';`;

const newUnitString = `// Whitelist of units where a spelled-out number IS ATS-meaningful.
// Deliberately excludes: minutes, hours, days, weeks, months — those
// read fine as words ("six minutes") and ATS doesn't search them.
const UNIT_PATTERN = '(?:years?|yrs?|%+|x|ms|s|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|projects?|bugs?|tests?|KB|MB|GB|TB|\\\\$|USD|uptime|core_skills?)';`;

if (c.includes(oldUnitString)) {
    c = c.replace(oldUnitString, newUnitString);
    console.log('Updated UNIT_PATTERN (excluded minutes/hours/days)');
}

fs.writeFileSync(p, c);
