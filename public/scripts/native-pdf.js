// Shared by browser and server. References survive text-only preset processing;
// only the backend replaces them with PDF parts after prompt conversion.
export const NATIVE_PDF_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, files: 4, pages: 100,
    totalBytes: 12 * 1024 * 1024, requestBytes: 20 * 1024 * 1024, estimatedTokensPerPage: 4096 });
const markerPattern = /\[\[ST_NATIVE_PDF:([a-f0-9-]{36}):([a-f0-9]{64}):(\d{1,3})\]\]/g;

/** @param {object} file @returns {string} Opaque reference, never file contents */
export function nativePdfMarker(file) {
    return `[[ST_NATIVE_PDF:${file.id}:${file.sha256}:${file.pages}]]`;
}

/** @param {object[]|object} messages @returns {object[]} References in selected text */
export function getNativePdfReferences(messages) {
    const refs = [];
    for (const message of Array.isArray(messages) ? messages : [messages]) {
        const content = message?.content;
        const texts = typeof content === 'string' ? [content] : Array.isArray(content)
            ? content.filter(part => part?.type === 'text').map(part => part.text) : [];
        for (const text of texts) {
            if (typeof text !== 'string') continue;
            for (const match of text.matchAll(markerPattern)) {
                refs.push({ marker: match[0], id: match[1], sha256: match[2], pages: Number(match[3]) });
            }
            if (text.replace(markerPattern, '').includes('[[ST_NATIVE_PDF:')) {
                throw new Error('A native PDF reference was damaged. Reattach the PDF or use text extraction.');
            }
        }
    }
    return refs;
}

/** @param {object[]} expected @param {object[]|object} messages */
export function assertNativePdfReferences(expected, messages) {
    const before = expected.map(ref => ref.marker).sort();
    const after = getNativePdfReferences(messages).map(ref => ref.marker).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error('Prompt processing removed or duplicated a native PDF. Use text extraction or disable the conflicting preset processing.');
    }
}

/** @param {object} settings @returns {boolean} First-stage endpoint/model support */
export function supportsNativePdf(settings) {
    return settings.chat_completion_source === 'vertexai' && !settings.reverse_proxy
        && ['full', 'express'].includes(settings.vertexai_auth_mode || 'express')
        && (settings.model || settings.vertexai_model) === 'gemini-4-argon';
}

/** @param {object} body @returns {object[]} Validated selected references */
export function validateNativePdfRequest(body) {
    const refs = getNativePdfReferences(body.messages);
    if (body.native_pdf_refs !== undefined) {
        if (!Array.isArray(body.native_pdf_refs)) throw new Error('Invalid native PDF manifest.');
        assertNativePdfReferences(body.native_pdf_refs.map(marker => ({ marker })), body.messages);
    }
    if (!refs.length) return refs;
    if (!supportsNativePdf(body)) throw new Error('Original PDFs currently require native Vertex AI with gemini-4-argon. Reattach using text extraction for this connection.');
    if (refs.length > NATIVE_PDF_LIMITS.files || refs.some(ref => ref.pages < 1)
        || refs.reduce((sum, ref) => sum + ref.pages, 0) > NATIVE_PDF_LIMITS.pages) {
        throw new Error('Native PDF context limit: 4 attachments and 100 pages in total.');
    }
    return refs;
}

/** @param {object[]|object} messages @returns {number} Deliberately approximate context reservation */
export function estimateNativePdfTokens(messages) {
    return getNativePdfReferences(messages).reduce((sum, ref) => sum + ref.pages * NATIVE_PDF_LIMITS.estimatedTokensPerPage, 0);
}
