const fs = require('fs');
const path = require('path');
const { generateResume, buildResumeDocx, buildArchiveResumeFilename, writeReadyResumeCopy, buildUploadResumeFilename } = require('./resumeService');
const { asNodeBuffer } = require('../utils/asNodeBuffer');
const {
    validateResumeHtml,
    buildStackValidationFeedback
} = require('./resumeValidationService');
const {
    buildResumeQualityReport,
    buildQualityRemakeFeedback
} = require('./resumeQualityReportService');
const templateService = require('./templateService');
const userTemplateService = require('./userTemplateService');

// One LLM draft per Generate by default — saves API keys.
// The 4-pass quality report still runs and is shown in the UI.
// Auto remakes only when RESUME_MAX_QUALITY_ATTEMPTS / VALIDATION > 1
// or the client sends auto_quality_remake: true (opt-in spend).
const MAX_VALIDATION_ATTEMPTS = Math.max(
    1,
    parseInt(process.env.RESUME_MAX_VALIDATION_ATTEMPTS || '1', 10) || 1
);
const MAX_QUALITY_ATTEMPTS = Math.max(
    1,
    parseInt(process.env.RESUME_MAX_QUALITY_ATTEMPTS || '1', 10) || 1
);

function resolveStyleSpecForGeneration(req, profile, body, existingApplication = null) {
    const tplSource = body.template_source
        || (profile.preferred_template_kind === 'user' ? 'user' : 'admin');

    const effectiveTemplateId = body.template_id != null
        ? body.template_id
        : (profile.preferred_template_id != null
            ? profile.preferred_template_id
            : (existingApplication?.template_id ?? null));

    let styleSpec;
    if (tplSource === 'user' && effectiveTemplateId) {
        let userSpec = userTemplateService.resolveStyleSpecForUser(req.user.id, effectiveTemplateId);
        if (!userSpec) {
            userSpec = userTemplateService.resolveStyleSpecAnyOwner(effectiveTemplateId);
        }
        styleSpec = userSpec || templateService.resolveStyleSpec({ templateId: null });
    } else {
        styleSpec = templateService.resolveStyleSpec({ templateId: effectiveTemplateId });
    }

    // Prefer an explicit generation-time font, then a previously saved
    // application font (when font was omitted on regenerate), then the
    // template body font. Never pick a random font unless the user
    // explicitly chose "__random__".
    const explicit = body.font_family;
    const omitted = explicit == null || explicit === '';
    const wantRandom = explicit === '__random__'
        || (typeof explicit === 'string' && explicit.toLowerCase() === 'random');

    let font = null;
    if (!omitted && !wantRandom) {
        font = templateService.normaliseFontName(explicit);
    }
    if (!font && !wantRandom) {
        font = templateService.normaliseFontName(existingApplication?.font_family);
    }
    if (!font && wantRandom) {
        const pool = Array.isArray(styleSpec?.body?.font_pool)
            ? styleSpec.body.font_pool
                .map((f) => templateService.normaliseFontName(f))
                .filter(Boolean)
            : [];
        if (pool.length > 0) {
            font = pool[Math.floor(Math.random() * pool.length)];
        }
    }
    if (!font) {
        font = templateService.normaliseFontName(styleSpec?.body?.font)
            || templateService.normaliseFontName(styleSpec?.fonts?.body)
            || 'Arial';
    }

    // Stamp the generation font onto every slot / heading so preview,
    // DOCX, and PDF use one consistent typeface (no mixed template fonts).
    const stampFont = (obj) => (obj && typeof obj === 'object' ? { ...obj, font } : obj);
    if (styleSpec) {
        const stampedSlots = {};
        if (styleSpec.slots && typeof styleSpec.slots === 'object') {
            for (const [k, v] of Object.entries(styleSpec.slots)) {
                stampedSlots[k] = stampFont(v);
            }
        }
        const stampedHeading = {};
        if (styleSpec.heading && typeof styleSpec.heading === 'object') {
            for (const [k, v] of Object.entries(styleSpec.heading)) {
                stampedHeading[k] = stampFont(v);
            }
        }
        styleSpec = {
            ...styleSpec,
            body: stampFont({ ...(styleSpec.body || {}) }),
            name: stampFont(styleSpec.name),
            contact: stampFont(styleSpec.contact),
            list: stampFont(styleSpec.list),
            heading: Object.keys(stampedHeading).length ? stampedHeading : styleSpec.heading,
            slots: Object.keys(stampedSlots).length ? stampedSlots : styleSpec.slots,
            fonts: {
                ...(styleSpec.fonts || {}),
                body: font,
                default: font,
                heading: font,
                name: font,
                contact: font
            }
        };
    }

    return { font, styleSpec, effectiveTemplateId, tplSource };
}

/**
 * Draft → stack/content check → auto-remake on fail → auto-finalize DOCX on pass.
 */
async function generateValidatedDraft(profile, jobDescription, providedCompany, req, body, existingApplication = null, options = {}) {
    const { autoFinalize = false, resumesDir = null } = options;
    const coreSkills = body.core_skills ?? existingApplication?.core_skills ?? '';

    const { font, styleSpec, effectiveTemplateId } = resolveStyleSpecForGeneration(
        req,
        profile,
        body,
        existingApplication
    );

    // Opt-in remakes only — each remake is another paid LLM call.
    const wantRemake = body.auto_quality_remake === true
        || body.auto_quality_remake === 1
        || body.auto_quality_remake === '1'
        || String(body.auto_quality_remake || '').toLowerCase() === 'true';
    const remakeCap = wantRemake
        ? Math.max(MAX_VALIDATION_ATTEMPTS, MAX_QUALITY_ATTEMPTS, 2)
        : 1;

    let validationFeedback = null;
    let lastValidation = { pass: false, issues: ['Generation did not run'] };
    let lastQuality = null;
    let result = null;
    let attempts = 0;
    const startedAt = Date.now();
    const maxAttempts = remakeCap;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        result = await generateResume(profile, jobDescription, providedCompany, {
            styleSpec,
            font,
            templateId: effectiveTemplateId,
            skipDocx: true,
            validationFeedback,
            coreSkills,
            jobUrl: body.job_url || body.jobUrl || existingApplication?.job_url || ''
        });

        lastValidation = validateResumeHtml(result.resumeHtml, {
            profile,
            jobDescription,
            companyName: result.companyName,
            coreSkills
        });

        lastQuality = buildResumeQualityReport(result.resumeHtml, {
            profile,
            jobDescription,
            coreSkills
        });

        const stackOk = lastValidation.pass;
        const qualityOk = lastQuality.pass;
        // Pass both → keep this draft (do not remake).
        if (stackOk && qualityOk) break;

        // Default: one draft only (saves API keys). Remake only when opted in.
        if (attempt >= maxAttempts || !wantRemake) break;

        const parts = [];
        if (!stackOk) {
            const stackFb = buildStackValidationFeedback(lastValidation);
            if (stackFb) parts.push(stackFb);
        }
        if (!qualityOk) {
            const qFb = buildQualityRemakeFeedback(lastQuality);
            if (qFb) parts.push(qFb);
        }
        validationFeedback = parts.filter(Boolean).join('\n\n');
        if (!validationFeedback) break;
        console.log(
            `[resumePipeline] attempt ${attempt}/${maxAttempts} failed `
            + `(stack=${stackOk ? 'ok' : 'fail'}, quality=${qualityOk ? 'ok' : 'fail'} `
            + `grade=${lastQuality.grade || '?'}) — regenerating (opt-in remake)`
        );
    }

    const companyName = (() => {
        const provided = (providedCompany && String(providedCompany).trim()) || '';
        if (provided && !/^unknown$/i.test(provided)) return provided;
        const fromResult = (result?.companyName && String(result.companyName).trim()) || '';
        if (fromResult && !/^unknown$/i.test(fromResult)) return fromResult;
        return fromResult || 'Unknown';
    })();

    let finalized = null;
    // Always write DOCX when HTML exists so Mode 1 autofill can upload a
    // resume even if stack validation did not fully pass. Status still
    // reflects validation so the UI can show issues.
    if (autoFinalize && resumesDir && result?.resumeHtml) {
        try {
            finalized = await finalizeDraftToDocx({
                profile,
                draftHtml: result.resumeHtml,
                companyName,
                styleSpec,
                font,
                templateId: effectiveTemplateId,
                resumesDir
            });
        } catch (err) {
            console.warn('[resumePipeline] auto-finalize DOCX failed:', err.message);
        }
    }

    const generationMs = Date.now() - startedAt;

    const llmMs = Number(result?.llm_ms) || 0;
    const polishMs = Number(result?.polish_ms) || 0;
    console.log(
        `[resumePipeline] total_ms=${generationMs} llm_ms=${llmMs} polish_ms=${polishMs} `
        + `attempts=${attempts} prompt_chars=${result?.prompt_chars || '?'} output_chars=${result?.output_chars || '?'}`
    );

    return {
        ...result,
        font,
        styleSpec,
        effectiveTemplateId,
        validation: lastValidation,
        validation_attempts: attempts,
        quality_report: lastQuality || buildResumeQualityReport(result?.resumeHtml || '', { profile }),
        quality_attempts: attempts,
        auto_quality_remake: wantRemake,
        generation_ms: generationMs,
        generation_seconds: Math.round(generationMs / 100) / 10,
        llm_ms: llmMs,
        polish_ms: polishMs,
        prompt_chars: result?.prompt_chars ?? null,
        output_chars: result?.output_chars ?? null,
        generation_status: finalized
            ? 'ready'
            : (lastValidation.pass ? 'pending' : 'failed'),
        is_finalized: !!finalized,
        resume_filename: finalized?.filename || null,
        resume_upload_filename: finalized?.upload_filename || null,
        resume_pdf_filename: finalized?.pdf_filename || null
    };
}

async function writeResumeFile(resumesDir, profile, companyName, resumeBuffer) {
    const fname = buildArchiveResumeFilename(profile, companyName, Date.now(), '.docx');
    const filepath = path.join(resumesDir, fname);
    const buf = await asNodeBuffer(resumeBuffer);
    fs.writeFileSync(filepath, buf);
    const uploadFilename = await writeReadyResumeCopy(buf, profile);
    return { filename: fname, upload_filename: uploadFilename || buildUploadResumeFilename(profile) };
}

async function finalizeDraftToDocx({
    profile,
    draftHtml,
    companyName,
    styleSpec,
    font,
    templateId,
    resumesDir
}) {
    const resumeBuffer = await buildResumeDocx({
        resumeHtml: draftHtml,
        profile,
        styleSpec,
        font
    });

    const written = await writeResumeFile(resumesDir, profile, companyName, resumeBuffer);
    const filename = written.filename;
    const uploadFilename = written.upload_filename;

    // PDF is built on Export PDF (or lazily later). Auto-writing PDF here
    // launches Chromium and routinely adds 5–20s to every Customize Resume.
    let pdfFilename = null;
    if (process.env.RESUME_AUTO_PDF === '1') {
        pdfFilename = await require('./resumePdfService').writePdfAlongsideDocx({
            resumesDir,
            docxFilename: filename,
            resumeHtml: draftHtml,
            styleSpec,
            font
        });
    }

    return {
        resumeBuffer,
        resumeHtml: draftHtml,
        filename,
        upload_filename: uploadFilename,
        pdf_filename: pdfFilename,
        template_id: templateId || null,
        font_family: font || 'Arial'
    };
}

module.exports = {
    MAX_VALIDATION_ATTEMPTS,
    MAX_QUALITY_ATTEMPTS,
    resolveStyleSpecForGeneration,
    generateValidatedDraft,
    finalizeDraftToDocx,
    writeResumeFile
};
