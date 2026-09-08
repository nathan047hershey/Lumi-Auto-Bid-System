/**
 * Shared time / period utilities for stats endpoints.
 *
 * The dashboard windows are anchored to GMT-4 (UTC-4) so the workday
 * and the rolling 24h period cover the same instant range. We treat
 * the offset as fixed (no DST adjustment) for period boundaries only;
 * the underlying data is still stored and compared in UTC, so this
 * choice only affects where the day's anchor line is drawn.
 */

/**
 * Compute the current "workday" window — 7am GMT-4 → next day 7am GMT-4.
 *
 * If the current GMT-4 time is before 7am, the workday started yesterday
 * at 7am GMT-4.
 *
 * @param {Date} [now=new Date()]
 * @returns {{ start: Date, end: Date }}
 */
function getCurrentWorkdayEST(now = new Date()) {
    const LOCAL_OFFSET_HOURS = -4;  // GMT-4

    const localNow = new Date(now.getTime() + LOCAL_OFFSET_HOURS * 60 * 60 * 1000);
    const localHours = localNow.getUTCHours();

    let refDate;
    if (localHours >= 7) {
        // After 7am GMT-4 today → workday = today 7am GMT-4 → tomorrow 7am GMT-4
        refDate = new Date(Date.UTC(
            localNow.getUTCFullYear(),
            localNow.getUTCMonth(),
            localNow.getUTCDate(),
            7, 0, 0, 0
        ));
    } else {
        // Before 7am GMT-4 today → workday = yesterday 7am GMT-4 → today 7am GMT-4
        refDate = new Date(Date.UTC(
            localNow.getUTCFullYear(),
            localNow.getUTCMonth(),
            localNow.getUTCDate() - 1,
            7, 0, 0, 0
        ));
    }

    const workdayStart = new Date(refDate.getTime() - LOCAL_OFFSET_HOURS * 60 * 60 * 1000);
    const workdayEnd = new Date(workdayStart.getTime() + 24 * 60 * 60 * 1000);

    return { start: workdayStart, end: workdayEnd };
}

/**
 * Return the current time as ISO 8601 with GMT-4 offset denoted.
 * Useful as a payload field for clients that want to show the server clock.
 *
 * Example output: "2026-07-01T14:32:00-04:00"
 */
function nowAsESTISOString(now = new Date()) {
    return new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().replace('Z', '-04:00');
}

/**
 * Format an ISO timestamp into a YYYY-MM-DD HH:mm:00 string (UTC),
 * suitable for SQL `>= ?` / `<= ?` comparisons against a datetime column.
 */
function toSqlDateTime(d) {
    if (!d) return '';
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Format a stored timestamp for display. The picker / write path no
 * longer applies ANY timezone conversion — what the user picked is
 * what we stored — so the display side just reads the components
 * straight off the string. We use `getUTC*` so we don't accidentally
 * re-interpret the value as local time on the server.
 *
 * Examples:
 *   "2026-07-12T14:32:00"  -> "2026-07-12 14:32"
 *   "2026-07-12T14:32:00"  -> "2026-07-12"      (dateOnly=true)
 *   "2026-07-12T14:32:55"  -> "2026-07-12 14:32"
 *
 * Legacy values (full ISO with Z or an offset) are still parsed and
 * rendered; the only thing we removed is the +4h / -4h wall-clock
 * shift that was misleading users.
 */
function formatGMT4(input, { dateOnly = false } = {}) {
    if (!input) return '';
    const s = String(input);
    // Pick the components straight off the string when it already
    // matches our stored shape. This avoids any `new Date(...)`
    // re-interpretation as local time on the server.
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
        if (dateOnly) return `${m[1]}-${m[2]}-${m[3]}`;
        return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    }
    // Fallback for unexpected formats — best-effort parse, no shift.
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    if (dateOnly) return `${yyyy}-${mm}-${dd}`;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Convert a `<input type="datetime-local">` string into a SQL-friendly
 * DATETIME value for storage. NO timezone interpretation — what the
 * user picked is what gets stored, byte for byte (we only append the
 * optional `:00` seconds segment if the picker omitted it so the
 * value fits the DATETIME column).
 *
 * Example: "2026-07-12T14:32" -> "2026-07-12T14:32:00"
 * Example: "2026-07-12T14:32:55" -> "2026-07-12T14:32:55"
 */
function localPickerToUTCIso(localStr) {
    if (!localStr) return null;
    const m = String(localStr).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const [, y, mo, d, hh, mi, ss = '00'] = m;
    // Return the picker value verbatim — no conversion, no UTC
    // interpretation, no timezone shift.
    return `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
}

/**
 * Convert a stored DATETIME value back into the
 * `YYYY-MM-DDTHH:mm` shape the datetime-local picker expects, by
 * reading the literal characters — NO timezone conversion. If the
 * stored value already matches the picker shape (e.g. legacy rows
 * saved before this change), we trim the seconds segment so the
 * picker shows it cleanly.
 *
 * Example: "2026-07-12T14:32:00" -> "2026-07-12T14:32"
 * Example: "2026-07-12T14:32:55" -> "2026-07-12T14:32"
 */
function utcIsoToLocalPicker(isoStr) {
    if (!isoStr) return '';
    const s = String(isoStr).trim();
    // Direct picker-shape match — strip seconds if present.
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
        return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    }
    // Fallback for unexpected formats — best-effort parse.
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

module.exports = {
    getCurrentWorkdayEST,
    nowAsESTISOString,
    toSqlDateTime,
    formatGMT4,
    localPickerToUTCIso,
    utcIsoToLocalPicker
};
