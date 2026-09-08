const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/jobLinks.js';
let c = fs.readFileSync(p, 'utf8');

// Improve refetch handler to show actual error and handle fallback result
const oldBlock = `        const jobDetailFetchService = require('../services/jobDetailFetchService');
        await jobDetailFetchService.enqueueJobDetailFetch(id, { source: 'admin-refetch' });
        res.json({ ok: true, id, enqueued: true });
    } catch (err) {
        console.error('Refetch job-link error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }`;

const newBlock = `        const jobDetailFetchService = require('../services/jobDetailFetchService');
        const enqueueResult = await jobDetailFetchService.enqueueJobDetailFetch(id, { source: 'admin-refetch' });
        res.json({ ok: true, id, enqueued: true, mode: enqueueResult.mode, result: enqueueResult.result });
    } catch (err) {
        console.error('Refetch job-link error:', err);
        const errMsg = err && err.message ? err.message : String(err);
        res.status(500).json({ error: errMsg });
    }`;

if (c.includes(oldBlock)) {
    c = c.replace(oldBlock, newBlock);
    fs.writeFileSync(p, c);
    console.log('✓ Improved refetch handler error reporting');
} else {
    console.log('✗ Refetch handler pattern not found');
}
