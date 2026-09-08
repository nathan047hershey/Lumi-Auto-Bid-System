/**
 * One-shot repair: company backfill, screenshot dedupe, filled_at sync.
 * Run: node extension/fixtures/_repair_all_courses.js
 */
const { initDatabase } = require('../../server/config/database');
const svc = require('../../server/services/bidCourseService');

(async () => {
    await initDatabase();
    const summary = svc.repairAllCourses({ limit: 500 });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.companyFixed || summary.appsFixed || summary.shotsRemoved) {
        console.error(
            '\nNote: if the API server is running, restart it (or POST /api/admin/bid-courses/repair) '
            + 'so it reloads the repaired database — otherwise the server may overwrite fixes on disk.'
        );
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
