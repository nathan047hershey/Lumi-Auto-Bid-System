/**
 * Local fill lessons — mirror Apply-button lessons for stuck-at-FILLED fixes.
 */
const FILL_LESSONS_KEY = 'bidderFillLessons';
const MAX_LESSONS = 80;

export function upsertFillLessonLocal(cur, lesson) {
    const list = Array.isArray(cur) ? [...cur] : [];
    const host = String(lesson.host || '').replace(/^www\./i, '').toLowerCase();
    const fieldKey = String(lesson.fieldKey || lesson.field_key || 'form');
    const issueKey = String(lesson.issueKey || lesson.issue_key || 'user_instruct');
    if (!host) return list;
    const idx = list.findIndex(
        (l) => l.host === host && l.fieldKey === fieldKey && l.issueKey === issueKey
    );
    const row = {
        host,
        fieldKey,
        issueKey,
        instruction: String(lesson.instruction || '').slice(0, 500),
        actions: lesson.actions || null,
        ats: lesson.ats || '',
        source: lesson.source || 'user_instruct',
        updatedAt: Date.now()
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.unshift(row);
    return list.slice(0, MAX_LESSONS);
}

export async function loadFillLessons() {
    try {
        return (await chrome.storage.local.get([FILL_LESSONS_KEY]))[FILL_LESSONS_KEY] || [];
    } catch {
        return [];
    }
}

export async function saveFillLesson(lesson) {
    try {
        const cur = await loadFillLessons();
        const next = upsertFillLessonLocal(cur, lesson);
        await chrome.storage.local.set({ [FILL_LESSONS_KEY]: next });
        return next;
    } catch {
        return [];
    }
}

export async function lessonsForHost(host) {
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    if (!h) return [];
    const all = await loadFillLessons();
    return all.filter((l) => l.host === h || h.endsWith(`.${l.host}`));
}

export function matchLesson(lessons, { fieldKey, issueKey } = {}) {
    const list = Array.isArray(lessons) ? lessons : [];
    if (fieldKey && issueKey) {
        const exact = list.find((l) => l.fieldKey === fieldKey && l.issueKey === issueKey);
        if (exact) return exact;
    }
    if (fieldKey) {
        const byField = list.find((l) => l.fieldKey === fieldKey);
        if (byField) return byField;
    }
    return list[0] || null;
}
