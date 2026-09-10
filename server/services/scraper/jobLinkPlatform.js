/**
 * ATS / career-site platform for job_links filters.
 * Match source_url or job_apply_url with SQL LIKE (sql.js has no REGEXP).
 */
'use strict';

const JOB_LINK_PLATFORMS = [
    { id: 'greenhouse', label: 'Greenhouse', likes: ['%greenhouse.io%'] },
    { id: 'lever', label: 'Lever', likes: ['%lever.co%'] },
    { id: 'ashby', label: 'Ashby', likes: ['%ashbyhq.com%'] },
    { id: 'gem', label: 'Gem', likes: ['%jobs.gem.com%'] },
    { id: 'workday', label: 'Workday', likes: ['%myworkdayjobs.com%', '%workdayjobs.com%'] },
    { id: 'icims', label: 'iCIMS', likes: ['%icims.com%'] },
    { id: 'smartrecruiters', label: 'SmartRecruiters', likes: ['%smartrecruiters.com%'] },
    { id: 'bamboohr', label: 'BambooHR', likes: ['%bamboohr.com%'] },
    { id: 'oracle', label: 'Oracle Cloud HCM', likes: ['%oraclecloud.com%'] },
    { id: 'linkedin', label: 'LinkedIn', likes: ['%linkedin.com%'] },
    { id: 'rippling', label: 'Rippling', likes: ['%rippling.com%'] },
    { id: 'jobvite', label: 'Jobvite', likes: ['%jobvite.com%'] },
    { id: 'paycom', label: 'Paycom', likes: ['%paycomonline.net%'] },
    { id: 'applytojob', label: 'ApplyToJob', likes: ['%applytojob.com%'] },
    { id: 'paylocity', label: 'Paylocity', likes: ['%paylocity.com%'] },
    { id: 'successfactors', label: 'SuccessFactors', likes: ['%successfactors.com%', '%sapsf.%'] },
    { id: 'generic', label: 'Other / generic', likes: [] }
];

const PLATFORM_BY_ID = new Map(JOB_LINK_PLATFORMS.map((p) => [p.id, p]));

function urlMatchSql(likeParamIndex) {
    return `(LOWER(IFNULL(source_url, '')) LIKE ? OR LOWER(IFNULL(job_apply_url, '')) LIKE ?)`;
}

function platformFilterSql(platformId) {
    const id = String(platformId || '').trim().toLowerCase();
    if (!id || id === 'all') return null;
    const spec = PLATFORM_BY_ID.get(id);
    if (!spec) return null;

    if (id === 'generic') {
        const knownLikes = JOB_LINK_PLATFORMS.flatMap((p) => p.likes);
        if (!knownLikes.length) return null;
        const parts = knownLikes.map(() => urlMatchSql());
        return {
            sql: `NOT (${parts.join(' OR ')})`,
            params: knownLikes.flatMap((like) => [like, like])
        };
    }

    if (!spec.likes.length) return null;
    const parts = spec.likes.map(() => urlMatchSql());
    return {
        sql: `(${parts.join(' OR ')})`,
        params: spec.likes.flatMap((like) => [like, like])
    };
}

module.exports = {
    JOB_LINK_PLATFORMS,
    platformFilterSql
};
